import assert from "node:assert/strict";
import test from "node:test";

import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiObjectId, SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import type { LaunchpadDeployment } from "../src/launchpad/transactions.ts";
import {
  LaunchpadCalls,
  LaunchpadTransactions,
} from "../src/launchpad/transactions.ts";
import type { SharedObjectReference } from "../src/lib/sui.ts";
import {
  assertBuildersMatchAbi,
  moveCallArguments,
  moveCallTypeArguments,
  readAbi,
} from "./abi.ts";

function shared<const Mutable extends boolean>(
  objectId: string,
  initialSharedVersion: number | string,
  mutable: Mutable,
): SharedObjectReference<Mutable> {
  return { objectId, initialSharedVersion, mutable };
}

const deployment: LaunchpadDeployment = {
  packageId: "0x123",
  originalPackageId: "0x123",
  partnersPackageId: "0xae",
  timelockPackageId: "0xaf",
  packageVersion: shared("0x2", "10", false),
  launchConfig: shared("0x3", "11", false),
  runtimeConfig: shared("0x4", "12", false),
  admin: { packageId: "0xad", acl: shared("0x5", "13", false) },
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

test("completes an adapter-started launch: settings, finalize, and share", () => {
  const calls = new LaunchpadCalls(deployment);
  const tx = new Transaction();
  const initializer = tx.object("0xe");
  const bought = tx.add(
    calls.completeLaunch({
      ...types,
      initializer,
      currency: shared("0xd", "22", true),
      creationFee: "0x5f",
      virtualQuote: 1_000n,
      graduationTarget: 3_000n,
      allocationPlan,
      lpFeeSplit,
      openingRoundMs: 60_000n,
      partner: shared("0x9a", "30", false),
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
    "launch::share",
  ]);
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
  const share = moveCall(tx, "launch::share");
  assert.deepEqual(share.arguments.map(argumentKind(tx)), [
    `Result:${commandIndex(tx, "launch::finalize")}`,
    `shared:${SUI_CLOCK_OBJECT_ID}`,
  ]);
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
      creationFee: "0x5f",
      virtualQuote: 1_000n,
      graduationTarget: 3_000n,
      allocationPlan,
      lpFeeSplit,
      openingRoundMs: 0n,
      preShareBuy: { quoteCoin: "0x77", minMemeOut: 5n },
    }),
  );

  assert.ok(bought);
  const launchCalls = moveFunctions(tx).filter((name) =>
    name.startsWith("launch::"),
  );
  assert.deepEqual(launchCalls, [
    "launch::set_virtual_quote",
    "launch::set_graduation_target",
    "launch::set_allocation_plan",
    "launch::set_lp_fee_split",
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

test("bids the creator's purchase into the opening round before sharing", () => {
  const calls = new LaunchpadCalls(deployment);
  const tx = new Transaction();
  const bought = tx.add(
    calls.completeLaunch({
      ...types,
      initializer: tx.object("0xe"),
      currency: shared("0xd", "22", true),
      creationFee: "0x5f",
      virtualQuote: 1_000n,
      graduationTarget: 3_000n,
      allocationPlan,
      lpFeeSplit,
      openingRoundMs: 300_000n,
      preShareBuy: { quoteCoin: "0x77", minMemeOut: 0n },
    }),
  );

  assert.equal(bought, undefined);
  assert.deepEqual(
    moveFunctions(tx)
      .filter((name) => name.startsWith("launch::"))
      .slice(-3),
    ["launch::finalize", "launch::join_opening_round", "launch::share"],
  );
  assert.deepEqual(
    moveCall(tx, "launch::join_opening_round").arguments.map(argumentKind(tx)),
    [
      `Result:${commandIndex(tx, "launch::finalize")}`,
      "shared:0x2",
      "object:0x77",
      `shared:${SUI_CLOCK_OBJECT_ID}`,
    ],
  );
});

test("rejects creation settings finalize aborts on", () => {
  const calls = new LaunchpadCalls(deployment);
  const tx = new Transaction();
  const base = { ...types, initializer: tx.object("0xe") };
  assert.throws(
    () => calls.setVirtualQuote({ ...base, virtualQuote: 0n }),
    /virtualQuote must be a positive u64/,
  );
  for (const openingRoundMs of [59_999n, 300_001n]) {
    assert.throws(
      () => calls.setOpeningRound({ ...base, openingRoundMs }),
      /zero or between 60,000 and 300,000/,
    );
  }
  assert.doesNotThrow(() =>
    calls.setOpeningRound({ ...base, openingRoundMs: 0n }),
  );
});

test("composes the opening round's join, settlement, and deliveries", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const launch = shared("0xc", "20", true);
  const join = sdk.joinOpeningRound({ ...types, launch, quoteAmount: 500n });
  assert.deepEqual(moveFunctions(join), ["launch::join_opening_round"]);
  assert.equal(join.getData().commands[0]?.$kind, "$Intent");
  assert.deepEqual(moveArgumentKinds(join, 1), [
    "shared:0xc",
    "shared:0x2",
    "Result",
    `shared:${SUI_CLOCK_OBJECT_ID}`,
  ]);
  assert.throws(
    () => sdk.joinOpeningRound({ ...types, launch, quoteAmount: 0n }),
    /positive u64/,
  );

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

test("composes admin sign-in with a protocol fee claim", () => {
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
  assert.ok(
    sharedInputs(tx).some(
      (input) => input.objectId.endsWith("05") && input.mutable === false,
    ),
  );
  assert.deepEqual(
    moveCall(tx, "launch::claim_protocol_fees").arguments.map(argumentKind(tx)),
    [
      "shared:0xc",
      "shared:0x2",
      `Result:${commandIndex(tx, "blast_acl::sign_in")}`,
    ],
  );
  assert.equal(transferObjectCount(tx), 3);

  const partnered = sdk.claimProtocolFees({
    ...types,
    launch: shared("0xc", "20", true),
    adminCapId: "0xe",
    recipient: "0xf",
    partner: shared("0x9a", "30", false),
  });
  assert.deepEqual(
    moveCall(
      partnered,
      "launch::claim_protocol_fees_with_partner",
    ).arguments.map(argumentKind(partnered)),
    [
      "shared:0xc",
      "shared:0x2",
      `Result:${commandIndex(partnered, "blast_acl::sign_in")}`,
      "shared:0x9a",
      `shared:${SUI_CLOCK_OBJECT_ID}`,
    ],
  );
  assert.equal(transferObjectCount(partnered), 3);
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

test("signs in with each operator role and calls every launchpad setter", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const abi = readAbi("production-launchpad-v1.json", "launchpad");
  const partner = shared("0xb1", "5", false);
  const launch = shared("0xc", "20", true);
  const adminCapId = "0xadc";
  const cases: [Transaction, string, string, string[]][] = [
    [
      sdk.setProtocolAllocation({ adminCapId, memeBps: 100n, quoteBps: 200n }),
      "TreasuryAdmin",
      "launch_config::set_protocol_allocation",
      ["shared-mut:0x3", "shared:0x2", "result:0", "result:1", "result:2"],
    ],
    [
      sdk.setMemeDecimalsAllowed({ adminCapId, decimals: 8, allowed: true }),
      "ListingAdmin",
      "launch_config::set_meme_decimals_allowed",
      ["shared-mut:0x3", "shared:0x2", "result:0", "pure", "pure"],
    ],
    [
      sdk.setQuoteAllowed({
        adminCapId,
        quoteType: "0x2::sui::SUI",
        allowed: true,
      }),
      "ListingAdmin",
      "launch_config::set_quote_allowed",
      ["shared-mut:0x3", "shared:0x2", "result:0", "pure"],
    ],
    [
      sdk.setTradeFees({ adminCapId, quoteFeeBps: 100n, memeFeeBps: 50n }),
      "FeeAdmin",
      "launch_config::set_trade_fees",
      ["shared-mut:0x3", "shared:0x2", "result:0", "result:1", "result:2"],
    ],
    [
      sdk.setCreationFee({ adminCapId, creationFee: 1_000n }),
      "FeeAdmin",
      "launch_config::set_creation_fee",
      ["shared-mut:0x3", "shared:0x2", "result:0", "pure"],
    ],
    [
      sdk.addPartner({ adminCapId, partner }),
      "FeeAdmin",
      "launch_config::add_partner",
      ["shared-mut:0x3", "shared:0x2", "result:0", "shared:0xb1"],
    ],
    [
      sdk.removePartner({ adminCapId, partner }),
      "FeeAdmin",
      "launch_config::remove_partner",
      ["shared-mut:0x3", "shared:0x2", "result:0", "shared:0xb1", "clock"],
    ],
    [
      sdk.setMigrationWitnessAllowed({
        adminCapId,
        migrationWitnessType: "0x9::cetus::Witness",
        allowed: false,
      }),
      "AdapterAdmin",
      "launch_config::set_migration_witness_allowed",
      ["shared-mut:0x3", "shared:0x2", "result:0", "pure"],
    ],
    [
      sdk.setCreatorClaimSigner({
        adminCapId,
        signerPublicKey: new Uint8Array(32),
      }),
      "ClaimSignerAdmin",
      "runtime_config::set_creator_claim_signer",
      ["shared-mut:0x4", "shared:0x2", "result:0", "pure"],
    ],
    [
      sdk.setProtocolFeeShare({ adminCapId, protocolFeeShareBps: 2_000n }),
      "FeeAdmin",
      "runtime_config::set_protocol_fee_share",
      ["shared-mut:0x4", "shared:0x2", "result:0", "result:1"],
    ],
    [
      sdk.reassignCurveFeeCap({
        ...types,
        launch,
        adminCapId,
        recipient: "0xd",
      }),
      "CreatorAdmin",
      "launch::reassign_curve_fee_cap",
      ["shared-mut:0xc", "shared:0x2", "result:0", "pure"],
    ],
    [
      sdk.reassignMetadataCap({
        ...types,
        launch,
        adminCapId,
        recipient: "0xd",
      }),
      "CreatorAdmin",
      "launch::reassign_metadata_cap",
      ["shared-mut:0xc", "shared:0x2", "result:0", "pure"],
    ],
  ];
  const covered = new Set<string>();
  for (const [tx, role, target, args] of cases) {
    const calls = assertBuildersMatchAbi(tx, abi, deployment.packageId);
    assert.equal(calls.at(-1), target);
    covered.add(target);
    const signIn = moveCallTypeArguments(tx)[0];
    assert.deepEqual(signIn, [
      `${normalizeSuiObjectId(deployment.originalPackageId)}::blast_fun_domain::${role}`,
    ]);
    assert.deepEqual(moveCallArguments(tx, 0), ["shared:0x5", "object:0xadc"]);
    assert.deepEqual(moveCallArguments(tx, calls.length), args, target);
  }
  const operatorTargets = Object.entries(abi).flatMap(([module, frozen]) =>
    frozen.functions
      .filter(
        (candidate) =>
          candidate.sdk === "builder" &&
          (module !== "launch" || candidate.name.startsWith("reassign_")),
      )
      .map((candidate) => `${module}::${candidate.name}`)
      .filter((name) => /^(launch_config|runtime_config|launch)::/.test(name)),
  );
  assert.deepEqual([...covered].sort(), operatorTargets.sort());
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
