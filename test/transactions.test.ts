import assert from "node:assert/strict";
import test from "node:test";

import { Transaction } from "@mysten/sui/transactions";
import {
  normalizeStructTag,
  normalizeSuiObjectId,
  SUI_CLOCK_OBJECT_ID,
} from "@mysten/sui/utils";
import type {
  LaunchpadDeployment,
  SharedObjectReference,
} from "../src/launchpad/transactions.ts";
import {
  addLaunchCompletion,
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
  partnersPackageId: "0xae",
  timelockPackageId: "0xaf",
  packageVersion: shared("0x2", "10", false),
  launchConfig: shared("0x3", "11", false),
  runtimeConfig: shared("0x4", "12", false),
  acl: shared("0x5", "13", false),
};
const partner = shared("0x16", "14", false);
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

test("completes an adapter-started launch: settings, finalize, bid, and share", () => {
  const calls = new LaunchpadCalls(deployment);
  const tx = new Transaction();
  const initializer = tx.object("0xe");
  const bought = tx.add(
    calls.completeLaunch({
      ...types,
      initializer,
      currency: shared("0xd", "22", true),
      creationFee: "0x99",
      virtualQuote: 1_000n,
      graduationTarget: 3_000n,
      allocationPlan,
      lpFeeSplit,
      openingRoundMs: 60_000n,
      partner,
      openingRoundBid: { quoteCoin: "0x77" },
    }),
  );

  assert.equal(bought, undefined);
  const launchCalls = moveFunctions(tx).filter((name) =>
    name.startsWith("launch::"),
  );
  assert.deepEqual(launchCalls, [
    "launch::set_virtual_quote",
    "launch::set_graduation_target",
    "launch::set_allocation_plan",
    "launch::set_lp_fee_split",
    "launch::set_opening_round",
    "launch::set_partner",
    "launch::finalize",
    "launch::join_opening_round",
    "launch::share",
  ]);
  assert.deepEqual(
    moveCall(tx, "launch::set_partner").arguments.map(argumentKind(tx)),
    [
      "object:0xe",
      "shared:0x3",
      "shared:0x16",
      `shared:${SUI_CLOCK_OBJECT_ID}`,
    ],
  );
  const finalize = moveCall(tx, "launch::finalize");
  assert.deepEqual(finalize.arguments.slice(1).map(argumentKind(tx)), [
    "shared:0xd",
    "shared:0x3",
    "object:0x99",
  ]);
  const finalized = `Result:${commandIndex(tx, "launch::finalize")}`;
  assert.deepEqual(
    moveCall(tx, "launch::join_opening_round").arguments.map(argumentKind(tx)),
    [finalized, "shared:0x2", "object:0x77", `shared:${SUI_CLOCK_OBJECT_ID}`],
  );
  const share = moveCall(tx, "launch::share");
  assert.deepEqual(share.arguments.map(argumentKind(tx)), [
    finalized,
    `shared:${SUI_CLOCK_OBJECT_ID}`,
  ]);
});

test("skips the optional settings and rejects a purchase the lifecycle forbids", () => {
  const calls = new LaunchpadCalls(deployment);
  const tx = new Transaction();
  const base = {
    ...types,
    initializer: tx.object("0xe"),
    currency: shared("0xd", "22", true),
    creationFee: "0x99",
    virtualQuote: 1_000n,
    graduationTarget: 3_000n,
    allocationPlan,
    lpFeeSplit,
  };
  tx.add(calls.completeLaunch({ ...base, openingRoundMs: 0n }));
  assert.deepEqual(
    moveFunctions(tx).filter((name) => name.startsWith("launch::set_")),
    [
      "launch::set_virtual_quote",
      "launch::set_graduation_target",
      "launch::set_allocation_plan",
      "launch::set_lp_fee_split",
    ],
  );
  assert.throws(
    () =>
      calls.completeLaunch({
        ...base,
        openingRoundMs: 60_000n,
        preShareBuy: { quoteCoin: "0x77", minMemeOut: 0n },
      }),
    /a pre-share purchase needs no opening round; a bid needs one/,
  );
  assert.throws(
    () =>
      calls.completeLaunch({ ...base, openingRoundBid: { quoteCoin: "0x77" } }),
    /a pre-share purchase needs no opening round; a bid needs one/,
  );
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
      initializer: tx.object("0xe"),
      currency: shared("0xd", "22", true),
      creationFee: "0x99",
      virtualQuote: 1_000n,
      graduationTarget: 3_000n,
      allocationPlan,
      lpFeeSplit,
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

test("pays the exact creation fee from gas when completing a launch", () => {
  const calls = new LaunchpadCalls(deployment);
  const tx = new Transaction();
  addLaunchCompletion(tx, calls, {
    ...types,
    initializer: tx.object("0xe"),
    currency: shared("0xd", "22", true),
    creationFee: 2_000_000_000n,
    virtualQuote: 1_000n,
    graduationTarget: 3_000n,
    allocationPlan,
    lpFeeSplit,
    preShareBuy: { quoteAmount: 10n, minMemeOut: 1n, recipient: "0xb" },
  });

  const intents = tx
    .getData()
    .commands.flatMap((command) =>
      command.$kind === "$Intent" ? [command.$Intent.data] : [],
    );
  assert.deepEqual(intents, [
    { type: "gas", balance: 2_000_000_000n, outputKind: "coin" },
    { type: "gas", balance: 10n, outputKind: "coin" },
  ]);
  assert.deepEqual(moveCall(tx, "launch::finalize").arguments.at(-1), {
    $kind: "Result",
    Result: 0,
  });
  assert.equal(transferObjectCount(tx), 2);
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
      "0x00000000000000000000000000000000000000000000000000000000000000af",
      "0x00000000000000000000000000000000000000000000000000000000000000ad",
      "0x00000000000000000000000000000000000000000000000000000000000000ae",
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

test("joins, settles, and delivers the opening round", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const launch = shared("0xc", "20", true);
  const join = sdk.joinOpeningRound({ ...types, launch, quoteAmount: 5n });
  assert.deepEqual(moveFunctions(join), ["launch::join_opening_round"]);
  assert.deepEqual(moveArgumentKinds(join, 1), [
    "shared:0xc",
    "shared:0x2",
    "Result",
    `shared:${SUI_CLOCK_OBJECT_ID}`,
  ]);

  const settle = sdk.settleOpeningRound({ ...types, launch });
  assert.deepEqual(moveArgumentKinds(settle, 0), [
    "shared:0xc",
    "shared:0x2",
    "shared:0x4",
    `shared:${SUI_CLOCK_OBJECT_ID}`,
  ]);

  const deliver = sdk.deliverOpeningRound({
    ...types,
    launch,
    bidders: ["0xa", "0xb"],
  });
  assert.deepEqual(moveFunctions(deliver), [
    "launch::deliver_opening_round",
    "launch::deliver_opening_round",
  ]);
  assert.deepEqual(moveArgumentKinds(deliver, 1), [
    "shared:0xc",
    "shared:0x2",
    "pure",
  ]);
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

test("signs in as TreasuryAdmin and routes all three protocol fee coins", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const base = {
    ...types,
    launch: shared("0xc", "20", true),
    adminCapId: "0xe",
    recipient: "0xf",
  };
  const tx = sdk.claimProtocolFees(base);

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
  assert.equal(transferObjectCount(tx), 3);

  const partnered = sdk.claimProtocolFees({ ...base, partner });
  assert.deepEqual(moveFunctions(partnered), [
    "blast_acl::sign_in",
    "launch::claim_protocol_fees_with_partner",
  ]);
  assert.deepEqual(moveArgumentKinds(partnered, 1), [
    "shared:0xc",
    "shared:0x2",
    "Result",
    "shared:0x16",
    `shared:${SUI_CLOCK_OBJECT_ID}`,
  ]);
  assert.equal(transferObjectCount(partnered), 3);
});

test("signs in with each launch_config setter's own role", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const adminCapId = "0xe";
  const cases = [
    [
      "set_protocol_allocation",
      "TreasuryAdmin",
      sdk.setProtocolAllocation({ adminCapId, memeBps: 1n, quoteBps: 2n }),
      ["Result", "Result"],
    ],
    [
      "set_meme_decimals_allowed",
      "ListingAdmin",
      sdk.setMemeDecimalsAllowed({ adminCapId, decimals: 8, allowed: true }),
      ["pure", "pure"],
    ],
    [
      "set_quote_allowed",
      "ListingAdmin",
      sdk.setQuoteAllowed({
        adminCapId,
        quoteType: "0x2::sui::SUI",
        allowed: true,
      }),
      ["pure"],
    ],
    [
      "set_trade_fees",
      "FeeAdmin",
      sdk.setTradeFees({ adminCapId, quoteFeeBps: 100n, memeFeeBps: 0n }),
      ["Result", "Result"],
    ],
    [
      "set_creation_fee",
      "FeeAdmin",
      sdk.setCreationFee({ adminCapId, creationFee: 1_000n }),
      ["pure"],
    ],
    [
      "add_partner",
      "FeeAdmin",
      sdk.addPartner({ adminCapId, partner }),
      ["shared:0x16"],
    ],
    [
      "remove_partner",
      "FeeAdmin",
      sdk.removePartner({ adminCapId, partner }),
      ["shared:0x16", `shared:${SUI_CLOCK_OBJECT_ID}`],
    ],
    [
      "set_migration_witness_allowed",
      "AdapterAdmin",
      sdk.setMigrationWitnessAllowed({
        adminCapId,
        migrationWitnessType: "0xf::cetus::Witness",
        allowed: false,
      }),
      ["pure"],
    ],
  ] as const;

  for (const [functionName, role, tx, extra] of cases) {
    const signIn = moveCall(tx, "blast_acl::sign_in");
    assert.deepEqual(signIn.typeArguments, [
      `${normalizeSuiObjectId("0x123")}::blast_fun_domain::${role}`,
    ]);
    const call = moveCall(tx, `launch_config::${functionName}`);
    assert.deepEqual(
      call.arguments
        .map(argumentKind(tx))
        .map((kind) => kind.replace(/^Result:\d+$/, "Result")),
      ["shared:0x3", "shared:0x2", "Result", ...extra],
    );
  }
  assert.ok(
    sharedInputs(sdk.setCreationFee({ adminCapId, creationFee: 1n })).some(
      (input) => input.objectId.endsWith("03") && input.mutable === true,
    ),
  );
  assert.deepEqual(
    moveCall(
      sdk.setQuoteAllowed({
        adminCapId,
        quoteType: "0x2::sui::SUI",
        allowed: true,
      }),
      "launch_config::set_quote_allowed",
    ).typeArguments,
    [normalizeStructTag("0x2::sui::SUI")],
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
