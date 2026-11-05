import assert from "node:assert/strict";
import test from "node:test";
import { packageRoleType } from "@interest-protocol/blast-admin-sdk/transactions";
import type { SharedObjectReference } from "@interest-protocol/blast-core/sui";
import {
  LaunchpadCalls,
  LaunchpadTransactions,
} from "@interest-protocol/blast-launchpad-sdk/transactions";
import { Transaction } from "@mysten/sui/transactions";
import {
  normalizeStructTag,
  normalizeSuiObjectId,
  SUI_CLOCK_OBJECT_ID,
} from "@mysten/sui/utils";
import { assertBuildersMatchAbi, readAbi } from "./abi.ts";
import { LAUNCHPAD_DEPLOYMENT as deployment } from "./fixtures/launchpad-deployment.ts";

function shared<const Mutable extends boolean>(
  objectId: string,
  initialSharedVersion: number | string,
  mutable: Mutable,
): SharedObjectReference<Mutable> {
  return { objectId, initialSharedVersion, mutable };
}

const abi = readAbi("production-launchpad-v1.json", "launchpad");
const coreAbi = readAbi("production-core-v1.json", "core");
const migratorsAbi = readAbi("production-migrators-v1.json", "migrators");
const vaultAbi = readAbi("production-vault-v1.json", "vault");
/** The composition's venue and vault calls, checked against their own ABIs. */
const venueCalls = (tx: Transaction) => [
  ...assertBuildersMatchAbi(tx, migratorsAbi, deployment.migrators.packageId),
  ...assertBuildersMatchAbi(tx, vaultAbi, deployment.vault.packageId),
];
const types = {
  memeType: "0xa::meme::MEME",
  quoteType: "0x2::sui::SUI",
};
const allocationPlan = {
  curveMemeBps: 7_000n,
  lpMemeBps: 2_000n,
  lpQuoteBps: 9_000n,
  recipients: [
    {
      recipient: { destination: "0xa", vestingTerms: null },
      memeBps: 300n,
      quoteBps: 0n,
    },
    {
      recipient: {
        destination: "0xb",
        vestingTerms: {
          cliffDelayMs: 0n,
          periodDurationMs: 1_000n,
          periods: 4n,
        },
      },
      memeBps: 200n,
      quoteBps: 500n,
    },
  ],
};
const lpFeeSplit = {
  routes: [
    { destination: { kind: "Owner" as const }, bps: 5_000n },
    { destination: { kind: "AutoLp" as const }, bps: 2_000n },
    { destination: { kind: "HolderRewards" as const }, bps: 2_000n },
    { destination: { kind: "Address" as const, address: "0xf" }, bps: 1_000n },
  ],
};
const settings = {
  ...types,
  ticket: "0x7c",
  treasuryCap: "0x7d",
  currency: shared("0xd", "22", true),
  virtualQuote: 1_000n,
  graduationTarget: 3_000n,
  allocationPlan,
  lpFeeSplit,
  creationFee: 5_000_000_000n,
};
const cetus = {
  venue: "cetus" as const,
  tier: { tickSpacing: 200 },
  cetus: {
    config: { objectId: "0xce1", initialSharedVersion: "1" },
    pools: { objectId: "0xce2", initialSharedVersion: "1" },
  },
};
const launch = shared("0xc", "20", true);

test("creates a launch in one PTB: venue ticket, new, settings, finalize, bid, share", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const tx = sdk.createLaunch({
    ...settings,
    ...cetus,
    openingRoundMs: 60_000n,
    partner: shared("0x9a", "30", false),
    preShareBuy: { quoteAmount: 1_000n, minMemeOut: 0n, recipient: "0xe" },
  });

  const launchpadCalls = assertBuildersMatchAbi(tx, abi, deployment.packageId);
  assert.deepEqual(launchpadCalls, [
    "launch::new",
    "launch::set_virtual_quote",
    "launch::set_graduation_target",
    "allocation::recipient_share",
    "allocation::recipient_share",
    "allocation::plan",
    "launch::set_allocation_plan",
    "launch::set_lp_fee_split",
    "launch::set_opening_round",
    "launch::set_partner",
    "launch::finalize",
    "launch::join_opening_round",
    "launch::share",
  ]);
  const coreCalls = assertBuildersMatchAbi(
    tx,
    coreAbi,
    deployment.core.packageId,
  );
  assert.ok(coreCalls.includes("payout::recipient"));
  assert.ok(coreCalls.includes("payout::vesting_terms"));
  assert.ok(coreCalls.includes("fee_split::new"));
  // The venue reserves the pool with the TreasuryCap first; `new` takes it by
  // value with the venue's ticket.
  const prepare = commandIndex(tx, "cetus::prepare");
  assert.ok(prepare >= 0 && prepare < commandIndex(tx, "launch::new"));
  assert.deepEqual(venueCalls(tx), ["cetus::prepare"]);
  assert.ok(argumentsOf(tx, "cetus::prepare").includes("object:0x7d"));
  assert.deepEqual(argumentsOf(tx, "launch::new"), [
    "object:0x7c",
    "object:0x7d",
    "shared:0x2",
    "shared:0x3",
    `Result:${prepare}`,
  ]);
  const initializer = `Result:${commandIndex(tx, "launch::new")}`;
  assert.deepEqual(argumentsOf(tx, "launch::set_partner"), [
    initializer,
    "shared:0x2",
    "shared:0x3",
    "shared:0x9a",
    `shared:${SUI_CLOCK_OBJECT_ID}`,
  ]);
  const finalize = argumentsOf(tx, "launch::finalize");
  assert.deepEqual(finalize.slice(0, 5), [
    initializer,
    "shared:0x2",
    "shared:0x7",
    "shared:0xd",
    "shared:0x3",
  ]);
  assert.match(finalize[5] ?? "", /^Result/);
  const owned = `Result:${commandIndex(tx, "launch::finalize")}`;
  assert.equal(argumentsOf(tx, "launch::join_opening_round")[0], owned);
  assert.deepEqual(argumentsOf(tx, "launch::share"), [
    owned,
    "shared:0x2",
    `shared:${SUI_CLOCK_OBJECT_ID}`,
  ]);
  // The registry and the currency are borrowed mutably; the version and
  // configuration immutably.
  const mutability = Object.fromEntries(
    sharedInputs(tx).map((input) => [
      normalizeSuiObjectId(input.objectId),
      input.mutable,
    ]),
  );
  assert.equal(mutability[normalizeSuiObjectId("0x7")], true);
  assert.equal(mutability[normalizeSuiObjectId("0xd")], true);
  assert.equal(mutability[normalizeSuiObjectId("0x2")], false);
  assert.equal(mutability[normalizeSuiObjectId("0x3")], false);
  // A bid is delivered after settlement: nothing to route now.
  assert.equal(transferObjectCount(tx), 0);
  const vectors = tx
    .getData()
    .commands.flatMap((command) =>
      command.$kind === "MakeMoveVec" ? [command.MakeMoveVec.type] : [],
    );
  assert.ok(
    vectors.includes(
      `${normalizeSuiObjectId("0x123")}::allocation::RecipientShare`,
    ),
  );
});

test("creates a Bluefin launch with a pre-share buy routed to the recipient", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const tx = sdk.createLaunch({
    ...settings,
    venue: "bluefin",
    tier: { tickSpacing: 200, feeRate: 10_000n },
    preShareBuy: { quoteAmount: 1_000n, minMemeOut: 5n, recipient: "0xe" },
  });
  assert.deepEqual(
    assertBuildersMatchAbi(tx, abi, deployment.packageId).filter((name) =>
      name.startsWith("launch::"),
    ),
    [
      "launch::new",
      "launch::set_virtual_quote",
      "launch::set_graduation_target",
      "launch::set_allocation_plan",
      "launch::set_lp_fee_split",
      "launch::finalize",
      "launch::buy",
      "launch::share",
    ],
  );
  assert.deepEqual(venueCalls(tx), ["bluefin::prepare"]);
  const owned = `Result:${commandIndex(tx, "launch::finalize")}`;
  const buy = argumentsOf(tx, "launch::buy");
  assert.deepEqual(
    [buy[0], buy[1], buy[2], buy[4]],
    [owned, "shared:0x2", "shared:0x4", "pure"],
  );
  const transfer = tx
    .getData()
    .commands.find((command) => command.$kind === "TransferObjects");
  assert.equal(transfer?.TransferObjects?.objects.length, 2);
  assert.throws(
    () =>
      sdk.createLaunch({
        ...settings,
        ...cetus,
        preShareBuy: { quoteAmount: 0n, minMemeOut: 0n, recipient: "0xe" },
      }),
    /quoteAmount must be a positive u64/,
  );
});

test("migrates in two calls: launch::migrate, then the venue redeems the Migration", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const currency = shared("0xd", "22", true);
  const viaCetus = sdk.migrate({
    ...types,
    launch,
    currency,
    venue: "cetus",
    cetus: {
      ...cetus.cetus,
      burnManager: { objectId: "0xce3", initialSharedVersion: "1" },
    },
  });
  assert.deepEqual(
    assertBuildersMatchAbi(viaCetus, abi, deployment.packageId),
    ["launch::migrate"],
  );
  assert.deepEqual(argumentsOf(viaCetus, "launch::migrate"), [
    "shared:0xc",
    "shared:0x2",
    "shared:0x3",
    "shared:0xd",
    `shared:${SUI_CLOCK_OBJECT_ID}`,
  ]);
  assert.deepEqual(venueCalls(viaCetus), ["cetus::migrate"]);
  assert.equal(
    argumentsOf(viaCetus, "cetus::migrate")[0],
    `Result:${commandIndex(viaCetus, "launch::migrate")}`,
  );

  const viaBluefin = sdk.migrate({
    ...types,
    launch,
    currency,
    venue: "bluefin",
    quoteCurrency: { objectId: "0xe", initialSharedVersion: "1" },
    bluefinConfig: { objectId: "0xbf", initialSharedVersion: "1" },
    creationFee: 5_000_000n,
  });
  assert.deepEqual(venueCalls(viaBluefin), ["bluefin::migrate"]);
  const redeem = argumentsOf(viaBluefin, "bluefin::migrate");
  assert.equal(
    redeem[0],
    `Result:${commandIndex(viaBluefin, "launch::migrate")}`,
  );
  // Bluefin's pool creation fee is a `Coin<SUI>` split for the call.
  assert.ok(redeem.slice(1).some((argument) => argument.startsWith("Result")));
});

test("owner actions prove ownership with the curve-fee cap in the same PTB", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const vault = { objectId: "0xfa9", initialSharedVersion: "40" };
  const owner = {
    ...types,
    launch: shared("0xc", "20", false),
    curveFeeCapId: "0xcf",
    vault,
  };
  const claim = sdk.claimOwnerBalances({ ...owner, recipient: "0xe" });
  assert.deepEqual(assertBuildersMatchAbi(claim, abi, deployment.packageId), [
    "launch::prove_owner",
  ]);
  assert.deepEqual(argumentsOf(claim, "launch::prove_owner"), [
    "shared:0xc",
    "shared:0x2",
    "object:0xcf",
  ]);
  assert.deepEqual(venueCalls(claim), ["vault::claim_owner_balances"]);
  assert.equal(
    argumentsOf(claim, "vault::claim_owner_balances")[1],
    `Result:${commandIndex(claim, "launch::prove_owner")}`,
  );
  assert.equal(transferObjectCount(claim), 2);
  // `prove_owner` reads the launch immutably.
  assert.equal(sharedInputs(claim)[0]?.mutable, false);

  const schedule = sdk.scheduleFeeSplit({ ...owner, feeSplit: lpFeeSplit });
  assert.deepEqual(venueCalls(schedule), ["vault::schedule_fee_split"]);
  const proposed = argumentsOf(schedule, "vault::schedule_fee_split");
  assert.deepEqual(
    [proposed[1], proposed[3]],
    [
      `Result:${commandIndex(schedule, "launch::prove_owner")}`,
      `Result:${commandIndex(schedule, "fee_split::new")}`,
    ],
  );
  const cancel = sdk.cancelFeeSplit(owner);
  assert.deepEqual(venueCalls(cancel), ["vault::cancel_fee_split"]);
  assert.equal(
    argumentsOf(cancel, "vault::cancel_fee_split")[1],
    `Result:${commandIndex(cancel, "launch::prove_owner")}`,
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
  assert.throws(
    () =>
      calls.allocationPlan({
        ...allocationPlan,
        recipients: [
          {
            recipient: { destination: "0x0", vestingTerms: null },
            memeBps: 0n,
            quoteBps: 0n,
          },
        ],
      }),
    /nonzero Sui address/,
  );
  assert.throws(
    () => calls.setLpFeeSplit({ ...base, lpFeeSplit: { routes: [] } }),
    /10,000/,
  );
});

test("composes the opening round's join, settlement, and deliveries", () => {
  const sdk = new LaunchpadTransactions(deployment);
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

test("constructs trades and claims, routing every returned coin and cap", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const buy = sdk.buy({
    ...types,
    launch,
    quoteAmount: 1_000n,
    minMemeOut: 900n,
    recipient: "0xd",
  });
  assert.deepEqual(moveFunctions(buy), ["launch::buy"]);
  assert.equal(buy.getData().commands[0]?.$kind, "$Intent");
  assert.equal(transferObjectCount(buy), 2);
  assert.deepEqual(
    sharedInputs(buy),
    [
      shared("0xc", "20", true),
      shared("0x2", "10", false),
      shared("0x4", "12", false),
    ].map(normalizedShared),
  );

  const sell = sdk.sell({
    ...types,
    launch,
    memeAmount: 1_000n,
    minQuoteOut: 900n,
    recipient: "0xd",
  });
  assert.deepEqual(moveFunctions(sell), ["launch::sell"]);
  assert.equal(transferObjectCount(sell), 1);

  const caps = sdk.claimCreatorCaps({ ...types, launch, recipient: "0xd" });
  assert.deepEqual(moveArgumentKinds(caps, 0), [
    "shared:0xc",
    "shared:0x2",
    "shared:0x4",
    "pure",
    `shared:${SUI_CLOCK_OBJECT_ID}`,
  ]);
  assert.equal(transferObjectCount(caps), 2);
  assert.ok(
    sharedInputs(caps).some(
      (input) =>
        input.objectId === SUI_CLOCK_OBJECT_ID &&
        BigInt(input.initialSharedVersion) === 1n &&
        input.mutable === false,
    ),
  );

  const fees = sdk.claimCreatorFees({
    ...types,
    launch,
    curveFeeCapId: "0xe",
    recipient: "0xd",
  });
  assert.deepEqual(moveArgumentKinds(fees, 0), [
    "shared:0xc",
    "shared:0x2",
    "object:0xe",
  ]);
  assert.equal(transferObjectCount(fees), 2);
  for (const tx of [buy, sell, caps, fees]) {
    assertBuildersMatchAbi(tx, abi, deployment.packageId);
  }
});

test("updates coin metadata through the live CreatorMetadataCap", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const base = {
    ...types,
    launch: shared("0xc", "20", false),
    creatorMetadataCapId: "0xe",
    currency: shared("0xf", "21", true),
  };

  for (const [functionName, tx] of [
    ["set_name", sdk.setName({ ...base, name: "Dog" })],
    ["set_description", sdk.setDescription({ ...base, description: "Good" })],
    ["set_icon_url", sdk.setIconUrl({ ...base, iconUrl: "https://x.y/z" })],
  ] as const) {
    assert.deepEqual(assertBuildersMatchAbi(tx, abi, deployment.packageId), [
      `launch::${functionName}`,
    ]);
    assert.deepEqual(moveArgumentKinds(tx, 0), [
      "shared:0xc",
      "shared:0x2",
      "object:0xe",
      "shared:0xf",
      "pure",
    ]);
  }
});

test("pays Blast's launch fees to the core treasury, and the partner when named", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const tx = sdk.claimProtocolFees({ ...types, launch });
  assert.deepEqual(assertBuildersMatchAbi(tx, abi, deployment.packageId), [
    "launch::claim_protocol_fees",
  ]);
  assert.deepEqual(argumentsOf(tx, "launch::claim_protocol_fees"), [
    "shared:0xc",
    "shared:0x2",
    "shared:0x7ea5",
  ]);
  assert.equal(transferObjectCount(tx), 0);

  const partnered = sdk.claimProtocolFees({
    ...types,
    launch,
    partner: shared("0x9a", "30", false),
  });
  assert.deepEqual(
    assertBuildersMatchAbi(partnered, abi, deployment.packageId),
    ["launch::claim_protocol_fees_with_partner"],
  );
  assert.deepEqual(
    argumentsOf(partnered, "launch::claim_protocol_fees_with_partner"),
    ["shared:0xc", "shared:0x2", "shared:0x7ea5", "shared:0x9a"],
  );
});

test("every launchpad builder matches the frozen ABI, signed in as its role", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const admin = "0xca";
  const venueType = "0xb0::cetus::Venue";
  const key = `0x${"09".repeat(32)}`;
  const partner = shared("0x9a", "30", false);
  const role = (tx: Transaction) => {
    const signIn = tx
      .getData()
      .commands.find(
        (command) =>
          command.$kind === "MoveCall" &&
          command.MoveCall.function === "sign_in",
      );
    return signIn?.$kind === "MoveCall"
      ? signIn.MoveCall.typeArguments[0]
      : null;
  };
  const domain = (name: string) =>
    normalizeStructTag(
      `${deployment.core.originalPackageId}::blast_domain::${name}`,
    );
  const built: [Transaction, string | null][] = [
    [
      sdk.setMemeDecimalsAllowed({
        adminCapId: admin,
        decimals: 8,
        allowed: true,
      }),
      "ListingAdmin",
    ],
    [
      sdk.setQuoteAllowed({
        adminCapId: admin,
        quoteType: "0x2::sui::SUI",
        allowed: true,
      }),
      "ListingAdmin",
    ],
    [sdk.addPartner({ adminCapId: admin, partner }), "FeeAdmin"],
    [sdk.removePartner({ adminCapId: admin, partner }), "FeeAdmin"],
    [
      sdk.scheduleProtocolAllocation({
        adminCapId: admin,
        memeBps: 1n,
        quoteBps: 1n,
        delayMs: 1n,
      }),
      "TreasuryAdmin",
    ],
    [sdk.applyProtocolAllocation(), null],
    [sdk.cancelProtocolAllocation({ adminCapId: admin }), "CancelAdmin"],
    [
      sdk.scheduleProtocolLpFees({
        adminCapId: admin,
        memeBps: 1n,
        quoteBps: 1n,
        delayMs: 1n,
      }),
      "FeeAdmin",
    ],
    [sdk.applyProtocolLpFees(), null],
    [sdk.cancelProtocolLpFees({ adminCapId: admin }), "CancelAdmin"],
    [
      sdk.scheduleTradeFees({
        adminCapId: admin,
        quoteFeeBps: 1n,
        memeFeeBps: 1n,
        delayMs: 1n,
      }),
      "FeeAdmin",
    ],
    [sdk.applyTradeFees(), null],
    [sdk.cancelTradeFees({ adminCapId: admin }), "CancelAdmin"],
    [
      sdk.scheduleCreationFee({
        adminCapId: admin,
        creationFee: 1n,
        delayMs: 1n,
      }),
      "FeeAdmin",
    ],
    [sdk.applyCreationFee(), null],
    [sdk.cancelCreationFee({ adminCapId: admin }), "CancelAdmin"],
    [sdk.scheduleVenue({ adminCapId: admin, venueType }), "VenueAdmin"],
    [sdk.applyVenue({ venueType }), null],
    [sdk.cancelVenue({ adminCapId: admin, venueType }), "CancelAdmin"],
    [sdk.removeVenue({ adminCapId: admin, venueType }), "VenueAdmin"],
    [sdk.scheduleVenueDelay({ adminCapId: admin, delayMs: 1n }), "VenueAdmin"],
    [sdk.applyVenueDelay(), null],
    [sdk.cancelVenueDelay({ adminCapId: admin }), "CancelAdmin"],
    [
      sdk.scheduleCreatorClaimSigner({
        adminCapId: admin,
        signerPublicKey: key,
      }),
      "ClaimSignerAdmin",
    ],
    [sdk.applyCreatorClaimSigner({ signerPublicKey: key }), null],
    [
      sdk.cancelCreatorClaimSigner({ adminCapId: admin, signerPublicKey: key }),
      "CancelAdmin",
    ],
    [
      sdk.revokeCreatorClaimSigner({ adminCapId: admin, signerPublicKey: key }),
      "ClaimSignerAdmin",
    ],
    [
      sdk.scheduleCreatorClaimSignerDelay({ adminCapId: admin, delayMs: 1n }),
      "ClaimSignerAdmin",
    ],
    [sdk.applyCreatorClaimSignerDelay(), null],
    [sdk.cancelCreatorClaimSignerDelay({ adminCapId: admin }), "CancelAdmin"],
    [
      sdk.scheduleProtocolFeeShare({
        adminCapId: admin,
        protocolFeeShareBps: 1n,
        delayMs: 1n,
      }),
      "FeeAdmin",
    ],
    [sdk.applyProtocolFeeShare(), null],
    [sdk.cancelProtocolFeeShare({ adminCapId: admin }), "CancelAdmin"],
    [
      sdk.scheduleCurveFeeCapDelay({
        adminCapId: admin,
        ...types,
        launch,
        delayMs: 1n,
      }),
      "CreatorAdmin",
    ],
    [
      sdk.scheduleCurveFeeCapReassignment({
        adminCapId: admin,
        ...types,
        launch,
        recipient: "0xe",
      }),
      "CreatorAdmin",
    ],
    [
      sdk.cancelCurveFeeCapReassignment({
        adminCapId: admin,
        ...types,
        launch,
      }),
      "CancelAdmin",
    ],
    [sdk.applyCurveFeeCapDelay({ ...types, launch }), null],
    [sdk.applyCurveFeeCapReassignment({ ...types, launch }), null],
    [
      sdk.scheduleCreatorMetadataCapDelay({
        adminCapId: admin,
        ...types,
        launch,
        delayMs: 1n,
      }),
      "CreatorAdmin",
    ],
    [
      sdk.scheduleCreatorMetadataCapReassignment({
        adminCapId: admin,
        ...types,
        launch,
        recipient: "0xe",
      }),
      "CreatorAdmin",
    ],
    [
      sdk.cancelCreatorMetadataCapReassignment({
        adminCapId: admin,
        ...types,
        launch,
      }),
      "CancelAdmin",
    ],
    [sdk.applyCreatorMetadataCapDelay({ ...types, launch }), null],
    [sdk.applyCreatorMetadataCapReassignment({ ...types, launch }), null],
  ];
  const covered = new Set<string>();
  for (const [tx, expected] of built) {
    const names = assertBuildersMatchAbi(tx, abi, deployment.packageId);
    for (const name of names) covered.add(name);
    assert.equal(role(tx), expected && domain(expected), names.join());
  }
  const unpause = sdk.unpause({ adminCapId: admin, bits: 7 });
  assert.deepEqual(assertBuildersMatchAbi(unpause, abi, deployment.packageId), [
    "launch_config::unpause",
  ]);
  covered.add("launch_config::unpause");
  const otw = normalizeStructTag("0x123::blast_fun::BLAST_FUN");
  assert.equal(
    role(unpause),
    packageRoleType(deployment.admin, otw, "UnpauseAdmin"),
  );
  // config, version (mut), the witness, package admin, runtime config,
  // core treasury, bits.
  assert.deepEqual(argumentsOf(unpause, "launch_config::unpause"), [
    "shared:0x3",
    "shared:0x2",
    `Result:${commandIndex(unpause, "blast_acl::sign_in")}`,
    "shared:0x8",
    "shared:0x4",
    "shared:0x7ea5",
    "pure",
  ]);
  assert.equal(
    sharedInputs(unpause).find(
      (input) =>
        normalizeSuiObjectId(input.objectId) === normalizeSuiObjectId("0x2"),
    )?.mutable,
    true,
  );
  assert.throws(
    () => sdk.unpause({ adminCapId: admin, bits: 8 }),
    /pause bits/,
  );
  // With creation, trading, claims, migration and ownership above, every
  // `launch_config` and `runtime_config` function and every launch
  // governance function has a builder.
  for (const module of ["launch_config", "runtime_config"]) {
    for (const { name } of abi[module]?.functions ?? []) {
      assert.ok(covered.has(`${module}::${name}`), `${module}::${name}`);
    }
  }
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

function argumentsOf(tx: Transaction, name: string): string[] {
  return moveCall(tx, name).arguments.map(argumentKind(tx));
}

test("configures a fresh launchpad at zero delays, then arms each delay", () => {
  const sdk = new LaunchpadTransactions(deployment);
  const admin = normalizeSuiObjectId(deployment.admin.packageId);
  // Each Move call, with its count of pure arguments.
  const calls = (tx: Transaction) => {
    const { commands, inputs } = tx.getData();
    return commands.flatMap((command) => {
      if (command.$kind !== "MoveCall") return [];
      const { module, function: name, arguments: args } = command.MoveCall;
      const pure = args.filter(
        (arg) => arg.$kind === "Input" && inputs[arg.Input]?.$kind === "Pure",
      ).length;
      return [`${module}::${name}${pure ? `/${pure}` : ""}`];
    });
  };
  const venueType = "0xb0::cetus::Venue";
  const configured = sdk.configureNow({
    adminCapId: "0xca",
    quoteTypes: ["0x2::sui::SUI"],
    partners: [shared("0x9a", "30", false)],
    tradeFees: { quoteFeeBps: 100n, memeFeeBps: 0n },
    protocolLpFees: { memeBps: 1_500n, quoteBps: 1_000n },
    creationFee: 5n,
    venueTypes: [venueType],
    creatorClaimSigners: [`0x${"09".repeat(32)}`],
  });
  assertBuildersMatchAbi(configured, abi, deployment.packageId);
  assert.deepEqual(calls(configured), [
    "blast_acl::sign_in",
    "launch_config::set_quote_allowed/1",
    "blast_acl::sign_in",
    "launch_config::add_partner",
    "bps::new/1",
    "bps::new/1",
    "launch_config::schedule_trade_fees/1",
    "launch_config::apply_trade_fees",
    "bps::new/1",
    "bps::new/1",
    "launch_config::schedule_protocol_lp_fees/1",
    "launch_config::apply_protocol_lp_fees",
    "launch_config::schedule_creation_fee/2",
    "launch_config::apply_creation_fee",
    "blast_acl::sign_in",
    "launch_config::schedule_venue",
    "launch_config::apply_venue",
    "blast_acl::sign_in",
    "runtime_config::schedule_creator_claim_signer/1",
    "runtime_config::apply_creator_claim_signer/1",
  ]);
  // Each role signs in once, and every schedule keeps a zero delay.
  assert.equal(
    configured
      .getData()
      .commands.filter(
        (command) =>
          command.$kind === "MoveCall" &&
          normalizeSuiObjectId(command.MoveCall.package) === admin,
      ).length,
    4,
  );
  const zero = configured
    .getData()
    .inputs.filter(
      (input) =>
        input.$kind === "Pure" &&
        input.Pure.bytes === Buffer.alloc(8).toString("base64"),
    );
  assert.ok(zero.length >= 3);

  const armed = sdk.armNotices({
    adminCapId: "0xca",
    creationFee: { creationFee: 5n, delayMs: 172_800_000n },
    venueDelayMs: 172_800_000n,
    claimSignerDelayMs: 172_800_000n,
  });
  assertBuildersMatchAbi(armed, abi, deployment.packageId);
  assert.deepEqual(calls(armed), [
    "blast_acl::sign_in",
    "launch_config::schedule_creation_fee/2",
    "launch_config::apply_creation_fee",
    "blast_acl::sign_in",
    "launch_config::schedule_venue_delay/1",
    "launch_config::apply_venue_delay",
    "blast_acl::sign_in",
    "runtime_config::schedule_creator_claim_signer_delay/1",
    "runtime_config::apply_creator_claim_signer_delay",
  ]);
});

test("rejects an incomplete deployment reference", () => {
  assert.throws(
    () =>
      new LaunchpadTransactions({
        ...deployment,
        runtimeConfig: { objectId: "0x4", initialSharedVersion: "0" },
      }),
    /launchpad\.runtimeConfig\.initialSharedVersion must be a positive u64/,
  );
});
