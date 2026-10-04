import assert from "node:assert/strict";
import test from "node:test";

import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiObjectId, SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import type {
  LaunchpadDeployment,
  SharedObjectReference,
} from "../src/launchpad/transactions.ts";
import {
  LaunchpadCalls,
  LaunchpadTransactions,
} from "../src/launchpad/transactions.ts";

function shared<const Mutable extends boolean>(
  objectId: string,
  initialSharedVersion: number | string,
  mutable: Mutable,
): SharedObjectReference<Mutable> {
  return { objectId, initialSharedVersion, mutable };
}

const deployment: LaunchpadDeployment = {
  packageId: "0x123",
  adminPackageId: "0xad",
  partnersPackageId: "0xbe",
  timelockPackageId: "0x71",
  packageVersion: shared("0x2", "10", false),
  launchConfig: shared("0x3", "11", false),
  runtimeConfig: shared("0x4", "12", false),
  acl: shared("0x5", "13", false),
};
const types = {
  memeType: "0xa::meme::MEME",
  quoteType: "0x2::sui::SUI",
};
const allocationPlan = {
  curveMemeBps: 7_000n,
  lpMemeBps: 2_000n,
  lpQuoteBps: 9_000n,
  recipients: [
    { destination: "0xa", memeBps: 300n, quoteBps: 0n },
    { destination: "0xb", memeBps: 200n, quoteBps: 500n },
  ],
};
const lpFeeSplit = {
  creatorBps: 5_000n,
  autoLpBps: 2_000n,
  rewardsBps: 2_000n,
  burnBps: 0n,
  recipients: [{ destination: "0xf", bps: 1_000n }],
};

const settings = {
  virtualQuote: 1_000n,
  graduationTarget: 3_000n,
  allocationPlan,
  lpFeeSplit,
  creationFee: 5_000_000_000n,
};

test("completes an opening-round launch: settings, finalize, creator bid, share", () => {
  const calls = new LaunchpadCalls(deployment);
  const tx = new Transaction();
  const initializer = tx.object("0xe");
  const bought = tx.add(
    calls.completeLaunch({
      ...types,
      ...settings,
      initializer,
      currency: shared("0xd", "22", true),
      openingRoundMs: 60_000n,
      partner: shared("0x9a", "30", false),
      creationFeeCoin: tx.object("0x5f"),
      creatorBid: { quoteCoin: "0x77" },
    }),
  );

  assert.equal(bought, undefined);
  assert.deepEqual(
    moveFunctions(tx).filter((name) => name.startsWith("launch::")),
    [
      "launch::set_virtual_quote",
      "launch::set_graduation_target",
      "launch::set_allocation_plan",
      "launch::set_lp_fee_split",
      "launch::set_opening_round",
      "launch::set_partner",
      "launch::finalize",
      "launch::join_opening_round",
      "launch::share",
    ],
  );
  assert.deepEqual(
    moveCall(tx, "launch::set_partner").arguments.map(argumentKind(tx)),
    [
      "object:0xe",
      "shared:0x3",
      "shared:0x9a",
      `shared:${SUI_CLOCK_OBJECT_ID}`,
    ],
  );
  const finalize = moveCall(tx, "launch::finalize");
  assert.deepEqual(finalize.arguments.map(argumentKind(tx)), [
    "object:0xe",
    "shared:0xd",
    "shared:0x3",
    "object:0x5f",
  ]);
  const join = moveCall(tx, "launch::join_opening_round");
  assert.deepEqual(join.arguments.map(argumentKind(tx)), [
    `Result:${commandIndex(tx, "launch::finalize")}`,
    "shared:0x2",
    "object:0x77",
    `shared:${SUI_CLOCK_OBJECT_ID}`,
  ]);
  assert.deepEqual(
    moveCall(tx, "launch::share").arguments.map(argumentKind(tx)),
    [
      `Result:${commandIndex(tx, "launch::finalize")}`,
      `shared:${SUI_CLOCK_OBJECT_ID}`,
    ],
  );
  assert.ok(
    sharedInputs(tx).some(
      (input) => input.objectId.endsWith("9a") && input.mutable === false,
    ),
  );
});

test("pays the exact creation fee from a SUI coin intent", () => {
  const calls = new LaunchpadCalls(deployment);
  const tx = new Transaction();
  tx.add(
    calls.completeLaunch({
      ...types,
      ...settings,
      initializer: tx.object("0xe"),
      currency: shared("0xd", "22", true),
    }),
  );

  const finalize = moveCall(tx, "launch::finalize");
  const intent = tx
    .getData()
    .commands.findIndex((command) => command.$kind === "$Intent");
  assert.deepEqual(finalize.arguments[3], {
    $kind: "Result",
    Result: intent,
  });
  assert.deepEqual(
    moveFunctions(tx).filter((name) => name.startsWith("launch::")),
    [
      "launch::set_virtual_quote",
      "launch::set_graduation_target",
      "launch::set_allocation_plan",
      "launch::set_lp_fee_split",
      "launch::finalize",
      "launch::share",
    ],
  );
});

test("rejects a creator purchase or bid the launch lifecycle cannot take", () => {
  const calls = new LaunchpadCalls(deployment);
  const base = {
    ...types,
    ...settings,
    initializer: { $kind: "Input", Input: 0, type: "object" } as never,
    currency: shared("0xd", "22", true),
  };
  assert.throws(
    () =>
      calls.completeLaunch({
        ...base,
        openingRoundMs: 60_000n,
        preShareBuy: { quoteCoin: "0x77", minMemeOut: 1n },
      }),
    /opening round/,
  );
  assert.throws(
    () => calls.completeLaunch({ ...base, creatorBid: { quoteCoin: "0x77" } }),
    /opening round/,
  );
  assert.throws(
    () => calls.completeLaunch({ ...base, virtualQuote: 0n }),
    /virtualQuote must be a positive u64/,
  );
});

test("joins, settles, and delivers the opening round", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const launch = shared("0xc", "20", true);
  const join = sdk.joinOpeningRound({ ...types, launch, quoteAmount: 7n });
  assert.deepEqual(moveFunctions(join), ["launch::join_opening_round"]);
  assert.equal(join.getData().commands[0]?.$kind, "$Intent");
  assert.equal(transferObjectCount(join), 0);

  const settle = sdk.settleOpeningRound({ ...types, launch });
  assert.deepEqual(moveArgumentKinds(settle, 0), [
    "shared:0xc",
    "shared:0x2",
    "shared:0x4",
    `shared:${SUI_CLOCK_OBJECT_ID}`,
  ]);

  const deliver = sdk.deliverOpeningRound({ ...types, launch, bidder: "0xa1" });
  assert.deepEqual(moveArgumentKinds(deliver, 0), [
    "shared:0xc",
    "shared:0x2",
    "pure",
  ]);
  // The contract transfers the bidder's Meme and refund itself.
  assert.equal(transferObjectCount(deliver), 0);
});

test("builds allocation plans and fee splits through their constructors", () => {
  const calls = new LaunchpadCalls(deployment);
  const tx = new Transaction();
  tx.add(calls.allocationPlan(allocationPlan));
  tx.add(calls.feeSplit(lpFeeSplit));

  const functions = moveFunctions(tx).filter((name) => name !== "bps::new");
  assert.deepEqual(functions, [
    "allocation::recipient",
    "allocation::recipient",
    "allocation::plan",
    "allocation::route",
    "allocation::fee_split",
  ]);
  const recipient = moveCall(tx, "allocation::recipient");
  assert.deepEqual(recipient.arguments.map(argumentKind(tx)).slice(1), [
    `Result:${commandIndex(tx, "allocation::recipient") - 2}`,
    `Result:${commandIndex(tx, "allocation::recipient") - 1}`,
  ]);
  assert.equal(functions.at(-1), "allocation::fee_split");
  const vectors = tx
    .getData()
    .commands.flatMap((command) =>
      command.$kind === "MakeMoveVec" ? [command.MakeMoveVec.type] : [],
    );
  assert.deepEqual(vectors, [
    `${normalizeSuiObjectId("0x123")}::allocation::Recipient`,
    `${normalizeSuiObjectId("0x123")}::allocation::Route`,
  ]);
  assert.throws(
    () => calls.feeSplit({ ...lpFeeSplit, creatorBps: 4_999n }),
    /sum to 10,000/,
  );
});

test("buys on the owned launch before sharing it", () => {
  const calls = new LaunchpadCalls(deployment);
  const tx = new Transaction();
  const bought = tx.add(
    calls.completeLaunch({
      ...types,
      ...settings,
      initializer: tx.object("0xe"),
      currency: shared("0xd", "22", true),
      preShareBuy: { quoteCoin: "0x77", minMemeOut: 5n },
    }),
  );

  assert.ok(bought);
  const launchCalls = moveFunctions(tx).filter((name) =>
    name.startsWith("launch::"),
  );
  assert.deepEqual(launchCalls.slice(-3), [
    "launch::finalize",
    "launch::buy",
    "launch::share",
  ]);
  const buy = moveCall(tx, "launch::buy");
  assert.deepEqual(buy.arguments.map(argumentKind(tx)), [
    `Result:${commandIndex(tx, "launch::finalize")}`,
    "shared:0x2",
    "shared:0x4",
    "object:0x77",
    "pure",
  ]);
});

test("constructs the generated Meme publish and makes it immutable", async () => {
  const sdk = new LaunchpadTransactions(deployment);
  const tx = sdk.publishMeme({
    symbol: "DOG",
    name: "Dog Coin",
    description: "Good dog",
    iconUrl: "https://example.com/dog.png",
    burnable: false,
    sellBurnBps: 0n,
    decimals: 9,
    creatorRecipient: { kind: "address", address: "0xc" },
  });

  await tx.prepareForSerialization({});
  assert.equal(tx.getData().commands[0]?.$kind, "Publish");
  assert.equal(tx.getData().commands[1]?.$kind, "MoveCall");
  const publish = tx.getData().commands[0];
  if (publish?.$kind === "Publish") {
    assert.deepEqual(publish.Publish.dependencies, [
      "0x0000000000000000000000000000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000000000000000000000000000002",
      "0x0000000000000000000000000000000000000000000000000000000000000071",
      "0x00000000000000000000000000000000000000000000000000000000000000ad",
      "0x00000000000000000000000000000000000000000000000000000000000000be",
      "0x0000000000000000000000000000000000000000000000000000000000000123",
    ]);
  }
  const makeImmutable = tx.getData().commands[1];
  if (makeImmutable?.$kind === "MoveCall") {
    assert.equal(makeImmutable.MoveCall.module, "package");
    assert.equal(makeImmutable.MoveCall.function, "make_immutable");
  }
  assert.equal(
    (await tx.build({ onlyTransactionKind: true })).length > 0,
    true,
  );
});

test("constructs a buy with exact-balance coin selection and output routing", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const tx = sdk.buy({
    ...types,
    launch: shared("0xc", "20", true),
    quoteAmount: 1_000n,
    minMemeOut: 900n,
    recipient: "0xd",
  });

  assert.deepEqual(moveFunctions(tx), ["launch::buy"]);
  assert.equal(tx.getData().commands[0]?.$kind, "$Intent");
  assert.equal(tx.getData().commands.at(-1)?.$kind, "TransferObjects");
  assert.deepEqual(
    sharedInputs(tx),
    [
      shared("0xc", "20", true),
      shared("0x2", "10", false),
      shared("0x4", "12", false),
    ].map(normalizedShared),
  );
});

test("constructs a sell and routes the returned Quote coin", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const tx = sdk.sell({
    ...types,
    launch: shared("0xc", "20", true),
    memeAmount: 1_000n,
    minQuoteOut: 900n,
    recipient: "0xd",
  });

  assert.deepEqual(moveFunctions(tx), ["launch::sell"]);
  assert.equal(tx.getData().commands[0]?.$kind, "$Intent");
  assert.equal(tx.getData().commands.at(-1)?.$kind, "TransferObjects");
});

test("routes both creator capability claim results", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const tx = sdk.claimCreatorCaps({
    ...types,
    launch: shared("0xc", "20", true),
    recipient: "0xd",
  });

  assert.deepEqual(moveFunctions(tx), ["launch::claim_creator_caps"]);
  assert.deepEqual(
    sharedInputs(tx),
    [
      shared("0xc", "20", true),
      shared("0x2", "10", false),
      shared("0x4", "12", false),
      shared(SUI_CLOCK_OBJECT_ID, 1, false),
    ].map(normalizedShared),
  );
  assert.deepEqual(moveArgumentKinds(tx, 0), [
    "shared:0xc",
    "shared:0x2",
    "shared:0x4",
    "pure",
    `shared:${SUI_CLOCK_OBJECT_ID}`,
  ]);
  assert.equal(transferObjectCount(tx), 2);
});

test("claims creator launch fees with the live curve-fee cap", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const tx = sdk.claimCreatorFees({
    ...types,
    launch: shared("0xc", "20", true),
    curveFeeCapId: "0xe",
    recipient: "0xd",
  });

  assert.deepEqual(moveFunctions(tx), ["launch::claim_creator_fees"]);
  assert.deepEqual(moveArgumentKinds(tx, 0), [
    "shared:0xc",
    "shared:0x2",
    "object:0xe",
  ]);
  assert.equal(transferObjectCount(tx), 2);
});

test("updates coin metadata through the live Blast metadata cap", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const base = {
    ...types,
    launch: shared("0xc", "20", false),
    blastMetadataCapId: "0xe",
    currency: shared("0xf", "21", true),
  };

  for (const [functionName, tx] of [
    ["set_name", sdk.setName({ ...base, name: "Dog" })],
    ["set_description", sdk.setDescription({ ...base, description: "Good" })],
    ["set_icon_url", sdk.setIconUrl({ ...base, iconUrl: "https://x.y/z" })],
  ] as const) {
    assert.deepEqual(moveFunctions(tx), [`launch::${functionName}`]);
    assert.deepEqual(moveArgumentKinds(tx, 0), [
      "shared:0xc",
      "shared:0x2",
      "object:0xe",
      "shared:0xf",
      "pure",
    ]);
    assert.deepEqual(
      sharedInputs(tx),
      [
        shared("0xc", "20", false),
        shared("0x2", "10", false),
        shared("0xf", "21", true),
      ].map(normalizedShared),
    );
  }
});

test("composes treasury-admin sign-in with a protocol fee claim", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const tx = sdk.claimProtocolFees({
    ...types,
    launch: shared("0xc", "20", true),
    adminCapId: "0xe",
    recipient: "0xf",
  });

  assert.deepEqual(moveFunctions(tx), [
    "blast_acl::sign_in",
    "launch::claim_protocol_fees",
  ]);
  const signIn = moveCall(tx, "blast_acl::sign_in");
  assert.equal(signIn.package, normalizeSuiObjectId("0xad"));
  assert.deepEqual(signIn.typeArguments, [
    `${normalizeSuiObjectId("0x123")}::blast_fun_domain::TreasuryAdmin`,
  ]);
  assert.deepEqual(signIn.arguments.map(argumentKind(tx)), [
    "shared:0x5",
    "object:0xe",
  ]);
  assert.deepEqual(
    moveCall(tx, "launch::claim_protocol_fees").arguments.map(argumentKind(tx)),
    [
      "shared:0xc",
      "shared:0x2",
      `Result:${commandIndex(tx, "blast_acl::sign_in")}`,
    ],
  );
  // Meme, Quote, and the SUI creation fee all go to the recipient.
  assert.equal(transferObjectCount(tx), 3);
  assert.ok(
    sharedInputs(tx).some(
      (input) => input.objectId.endsWith("05") && input.mutable === false,
    ),
  );
});

test("pays the launch's partner inside the protocol fee claim", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const tx = sdk.claimProtocolFees({
    ...types,
    launch: shared("0xc", "20", true),
    adminCapId: "0xe",
    recipient: "0xf",
    partner: shared("0x9a", "30", false),
  });

  assert.deepEqual(moveFunctions(tx), [
    "blast_acl::sign_in",
    "launch::claim_protocol_fees_with_partner",
  ]);
  assert.deepEqual(
    moveArgumentKinds(
      tx,
      commandIndex(tx, "launch::claim_protocol_fees_with_partner"),
    ),
    [
      "shared:0xc",
      "shared:0x2",
      "Result",
      "shared:0x9a",
      `shared:${SUI_CLOCK_OBJECT_ID}`,
    ],
  );
  assert.equal(transferObjectCount(tx), 3);
});

test("signs in with exactly the role each administrator action takes", () => {
  const calls = new LaunchpadCalls(deployment);
  const tx = new Transaction();
  tx.add(calls.signIn({ adminCap: "0xe", role: "BuybackAdmin" }));
  assert.deepEqual(moveCall(tx, "blast_acl::sign_in").typeArguments, [
    `${normalizeSuiObjectId("0x123")}::blast_fun_domain::BuybackAdmin`,
  ]);
  assert.throws(
    () => calls.signIn({ adminCap: "0xe", role: "RootAdmin" as never }),
    /unknown blast_fun administrator role/,
  );
});

test("uses a fully qualified immutable Clock reference", () => {
  const calls = new LaunchpadCalls(deployment);
  const tx = new Transaction();
  tx.add(
    calls.claimCreatorCaps({
      ...types,
      launch: shared("0xc", "20", true),
      accountAttestation: null,
    }),
  );

  assert.ok(
    sharedInputs(tx).some(
      (input) =>
        input.objectId === SUI_CLOCK_OBJECT_ID &&
        BigInt(input.initialSharedVersion) === 1n &&
        input.mutable === false,
    ),
  );
});

test("rejects incomplete or incorrectly mutable shared references", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const invalidLaunch = shared(
    "0xc",
    "20",
    false,
  ) as unknown as SharedObjectReference<true>;
  assert.throws(
    () =>
      sdk.buy({
        ...types,
        launch: invalidLaunch,
        quoteAmount: 1n,
        minMemeOut: 0n,
        recipient: "0xd",
      }),
    /launch\.mutable must be true/,
  );
  assert.throws(
    () =>
      new LaunchpadTransactions({
        ...deployment,
        runtimeConfig: shared("0x4", "0", false),
      }),
    /runtimeConfig\.initialSharedVersion must be a positive u64/,
  );
});

function moveFunctions(tx: Transaction): string[] {
  return tx
    .getData()
    .commands.flatMap((command) =>
      command.$kind === "MoveCall"
        ? [`${command.MoveCall.module}::${command.MoveCall.function}`]
        : [],
    );
}

function sharedInputs(tx: Transaction): SharedObjectReference[] {
  return tx
    .getData()
    .inputs.flatMap((input) =>
      input.$kind === "Object" && input.Object.$kind === "SharedObject"
        ? [input.Object.SharedObject]
        : [],
    );
}

function normalizedShared<const Mutable extends boolean>(
  reference: SharedObjectReference<Mutable>,
): SharedObjectReference<Mutable> {
  return {
    ...reference,
    objectId: normalizeSuiObjectId(reference.objectId),
  };
}

function commandIndex(tx: Transaction, name: string): number {
  return tx
    .getData()
    .commands.findIndex(
      (command) =>
        command.$kind === "MoveCall" &&
        `${command.MoveCall.module}::${command.MoveCall.function}` === name,
    );
}

function moveCall(tx: Transaction, name: string) {
  const command = tx.getData().commands[commandIndex(tx, name)];
  assert.ok(command?.$kind === "MoveCall");
  return command.MoveCall;
}

function argumentKind(tx: Transaction) {
  return (argument: TransactionArgumentData): string =>
    describeArgument(tx, argument);
}

type TransactionArgumentData = ReturnType<
  Transaction["getData"]
>["commands"][number] extends infer Command
  ? Command extends { MoveCall: { arguments: (infer Argument)[] } }
    ? Argument
    : never
  : never;

function describeArgument(
  tx: Transaction,
  argument: TransactionArgumentData,
): string {
  const data = tx.getData();
  if (argument.$kind === "Result") return `Result:${argument.Result}`;
  if (argument.$kind !== "Input") return argument.$kind;
  const input = data.inputs[argument.Input];
  if (input?.$kind === "Pure") return "pure";
  if (input?.$kind === "UnresolvedObject") {
    return `object:${shortId(input.UnresolvedObject.objectId)}`;
  }
  if (input?.$kind === "Object" && input.Object.$kind === "SharedObject") {
    const objectId = input.Object.SharedObject.objectId;
    return `shared:${objectId === SUI_CLOCK_OBJECT_ID ? objectId : shortId(objectId)}`;
  }
  return String(input?.$kind);
}

function moveArgumentKinds(tx: Transaction, commandIndex: number): string[] {
  const data = tx.getData();
  const command = data.commands[commandIndex];
  assert.ok(command?.$kind === "MoveCall");
  return command.MoveCall.arguments.map((argument) => {
    if (argument.$kind !== "Input") return argument.$kind;
    const input = data.inputs[argument.Input];
    if (input?.$kind === "Pure") return "pure";
    if (input?.$kind === "UnresolvedObject") {
      return `object:${shortId(input.UnresolvedObject.objectId)}`;
    }
    if (input?.$kind === "Object" && input.Object.$kind === "SharedObject") {
      const objectId = input.Object.SharedObject.objectId;
      return `shared:${objectId === SUI_CLOCK_OBJECT_ID ? objectId : shortId(objectId)}`;
    }
    return String(input?.$kind);
  });
}

function shortId(objectId: string): string {
  return `0x${BigInt(objectId).toString(16)}`;
}

function transferObjectCount(tx: Transaction): number {
  const transfer = tx.getData().commands.at(-1);
  return transfer?.$kind === "TransferObjects"
    ? transfer.TransferObjects.objects.length
    : 0;
}
