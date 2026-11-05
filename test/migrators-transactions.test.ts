import assert from "node:assert/strict";
import test from "node:test";
import {
  BLUEFIN_MAX_FEE_RATE,
  BLUEFIN_MAX_TICK_SPACING,
  MIGRATOR_VENUES,
  MigratorCalls,
  MigratorTransactions,
  venueOf,
  venueWitnessType,
} from "@interest-protocol/blast-migrators-sdk/transactions";
import { bcs } from "@mysten/sui/bcs";
import { Transaction } from "@mysten/sui/transactions";
import {
  fromBase64,
  normalizeStructTag,
  normalizeSuiAddress,
} from "@mysten/sui/utils";
import {
  abiCoverage,
  moveCallArguments,
  moveCallTypeArguments,
  readAbi,
} from "./abi.ts";
import {
  MEME_A,
  MEME_B,
  MIGRATORS,
  VENUE_OBJECTS as O,
  SUI,
} from "./fixtures/migrators-deployment.ts";

const calls = new MigratorCalls(MIGRATORS);
const coverage = abiCoverage(
  readAbi("production-migrators-v1.json", "migrators"),
  MIGRATORS.packageId,
);
const meme = normalizeStructTag(MEME_A);
const memeB = normalizeStructTag(MEME_B);
const sui = normalizeStructTag(SUI);

// Shared-object descriptors, named for the Move parameter each one fills.
const migratorsVersion = "shared:0x3010";
const venueConfig = (mutable: boolean) =>
  `${mutable ? "shared-mut" : "shared"}:0x3020`;
const registry = "shared-mut:0x2020";
const vaultVersion = "shared:0x2010";
const treasury = "shared:0x1030";

/** Every Move call's `module::function`, in command order. */
function targets(tx: Transaction): string[] {
  return coverage
    .check(tx)
    .getData()
    .commands.flatMap((command) => {
      if (command.$kind !== "MoveCall") return [];
      const call = command.MoveCall;
      return [
        `${normalizeSuiAddress(call.package)}::${call.module}::${call.function}`,
      ];
    });
}

/** The pure inputs of the `index`th Move call, decoded in argument order. */
function pureBytes(tx: Transaction, index: number): Uint8Array[] {
  const data = tx.getData();
  const call = data.commands.filter((command) => command.$kind === "MoveCall")[
    index
  ]?.MoveCall;
  assert.ok(call);
  return call.arguments.flatMap((argument) => {
    if (argument.$kind !== "Input") return [];
    const input = data.inputs[argument.Input];
    return input?.$kind === "Pure" ? [fromBase64(input.Pure.bytes)] : [];
  });
}

const target = (module: string, name: string) =>
  `${normalizeSuiAddress("0x3001")}::${module}::${name}`;

/** A stand-in for the product's `migrate`, returning the `Migration` result. */
function productMigration(tx: Transaction) {
  return tx.moveCall({ target: "0x99::launch::migrate" });
}

test("venue witnesses are <migrators original>::<venue>::Venue and map back", () => {
  assert.deepEqual(MIGRATOR_VENUES, ["bluefin", "cetus"]);
  for (const venue of MIGRATOR_VENUES) {
    const type = venueWitnessType(MIGRATORS, venue);
    assert.equal(type, normalizeStructTag(`0x3000::${venue}::Venue`));
    assert.equal(venueOf(MIGRATORS, type), venue);
  }
  assert.equal(venueOf(MIGRATORS, "0x3001::cetus::Venue"), null);
  assert.equal(venueOf(MIGRATORS, "0x3000::cetus::PoolTierKey"), null);
  assert.equal(
    calls.otw,
    normalizeStructTag("0x3000::blast_migrators::BLAST_MIGRATORS"),
  );
  assert.throws(
    () => venueWitnessType(MIGRATORS, "aftermath" as "cetus"),
    /unknown migrators venue/,
  );
});

test("prepareCetus calls cetus::prepare with the Move arity and returns the ticket", () => {
  const tx = new Transaction();
  const ticket = tx.add(
    calls.prepareCetus({
      memeType: MEME_A,
      quoteType: SUI,
      cetus: { config: O.cetusConfig, pools: O.cetusPools },
      treasuryCap: "0x7c",
      tickSpacing: 200,
    }),
  );
  tx.moveCall({ target: "0x99::launch::new", arguments: [ticket] });
  assert.deepEqual(targets(tx), [
    target("cetus", "prepare"),
    "0x0000000000000000000000000000000000000000000000000000000000000099::launch::new",
  ]);
  assert.deepEqual(moveCallTypeArguments(tx)[0], [meme, sui]);
  // (migrators_version, &mut venue_config, cetus_config, &mut pools, &mut treasury_cap, tick_spacing)
  assert.deepEqual(moveCallArguments(tx, 0), [
    migratorsVersion,
    venueConfig(true),
    "shared:0xc0f",
    "shared-mut:0xc00",
    "object:0x7c",
    "pure",
  ]);
  assert.equal(bcs.u32().parse(pureBytes(tx, 0)[0] as Uint8Array), 200);
  assert.deepEqual(moveCallArguments(tx, 1), ["result:0"]);
});

test("prepareBluefin calls bluefin::prepare and mirrors Bluefin's tier bounds", () => {
  const tx = new Transaction();
  tx.add(
    calls.prepareBluefin({
      memeType: MEME_A,
      quoteType: SUI,
      treasuryCap: "0x7c",
      currency: O.currency,
      tickSpacing: 60,
      feeRate: 3_000n,
    }),
  );
  assert.deepEqual(targets(tx), [target("bluefin", "prepare")]);
  assert.deepEqual(moveCallTypeArguments(tx)[0], [meme, sui]);
  // (migrators_version, &mut venue_config, &treasury_cap, &currency, tick_spacing, fee_rate)
  assert.deepEqual(moveCallArguments(tx, 0), [
    migratorsVersion,
    venueConfig(true),
    "object:0x7c",
    "shared:0xcc",
    "pure",
    "pure",
  ]);
  const [tick, fee] = pureBytes(tx, 0);
  assert.equal(bcs.u32().parse(tick as Uint8Array), 60);
  assert.equal(bcs.u64().parse(fee as Uint8Array), "3000");

  const base = {
    memeType: MEME_A,
    quoteType: SUI,
    treasuryCap: "0x7c",
    currency: O.currency,
  };
  assert.equal(BLUEFIN_MAX_TICK_SPACING, 400);
  assert.equal(BLUEFIN_MAX_FEE_RATE, 20_000n);
  calls.prepareBluefin({ ...base, tickSpacing: 400, feeRate: 20_000n });
  calls.prepareBluefin({ ...base, tickSpacing: 1, feeRate: 1n });
  for (const [tickSpacing, feeRate] of [
    [0, 1n],
    [401, 1n],
    [1, 0n],
    [1, 20_001n],
  ] as const) {
    assert.throws(
      () => calls.prepareBluefin({ ...base, tickSpacing, feeRate }),
      /Bluefin tier/,
    );
  }
  assert.throws(
    () => calls.prepareBluefin({ ...base, tickSpacing: 1.5, feeRate: 1n }),
    /u32/,
  );
});

for (const [memeType, memeIsA] of [
  [MEME_A, true],
  [MEME_B, false],
] as const) {
  const m = normalizeStructTag(memeType);
  const cetusTypes = memeIsA ? [m, sui, m, sui] : [m, sui, sui, m];

  test(`migrateCetus redeems the product's Migration in Cetus coin order (Meme is A=${memeIsA})`, () => {
    const tx = new Transaction();
    const migration = productMigration(tx);
    tx.add(
      calls.migrateCetus({
        migration,
        memeType,
        quoteType: SUI,
        cetus: {
          config: O.cetusConfig,
          pools: O.cetusPools,
          burnManager: O.burnManager,
        },
      }),
    );
    assert.equal(targets(tx)[1], target("cetus", "migrate"));
    assert.deepEqual(moveCallTypeArguments(tx)[1], cetusTypes);
    // (migration, migrators_version, venue_config, cetus_config, &mut pools,
    //  &mut burn_manager, &mut registry, vault_version, treasury, clock)
    assert.deepEqual(moveCallArguments(tx, 1), [
      "result:0",
      migratorsVersion,
      venueConfig(false),
      "shared:0xc0f",
      "shared-mut:0xc00",
      "shared-mut:0xb0",
      registry,
      vaultVersion,
      treasury,
      "clock",
    ]);
  });

  test(`Cetus fee routes and buyback take <Meme, Quote, CoinA, CoinB> (Meme is A=${memeIsA})`, () => {
    const vault = {
      memeType,
      quoteType: SUI,
      vault: O.vault,
      currency: O.currency,
      cetus: { config: O.cetusConfig, burnManager: O.burnManager },
      pool: O.pool,
    };
    // (&mut vault, migrators_version, vault_version, treasury, &mut currency,
    //  cetus_config, burn_manager, &mut pool, clock)
    const feeArguments = [
      "shared-mut:0x7a",
      migratorsVersion,
      vaultVersion,
      treasury,
      "shared-mut:0xcc",
      "shared:0xc0f",
      "shared:0xb0",
      "shared-mut:0x9001",
      "clock",
    ];
    for (const [name, step] of [
      ["collect_fees", calls.collectCetusFees(vault)],
      ["settle_and_apply_fee_split", calls.settleAndApplyCetusFeeSplit(vault)],
    ] as const) {
      const tx = new Transaction();
      tx.add(step);
      assert.deepEqual(targets(tx), [target("cetus", name)]);
      assert.deepEqual(moveCallTypeArguments(tx)[0], cetusTypes);
      assert.deepEqual(moveCallArguments(tx, 0), feeArguments);
    }

    const tx = new Transaction();
    const witness = tx.moveCall({ target: "0xad::blast_acl::sign_in" });
    tx.add(
      calls.buybackAndBurnCetus({
        memeType,
        quoteType: SUI,
        vault: O.vault,
        adminWitness: witness,
        currency: O.currency,
        cetus: { config: O.cetusConfig },
        pool: O.pool,
        quoteIn: 5_000n,
        minMemeOut: 0n,
      }),
    );
    assert.equal(targets(tx)[1], target("cetus", "buyback_and_burn"));
    assert.deepEqual(moveCallTypeArguments(tx)[1], cetusTypes);
    // (&mut vault, migrators_version, vault_version, &admin_witness, &mut currency,
    //  cetus_config, &mut pool, quote_in, min_meme_out, clock)
    assert.deepEqual(moveCallArguments(tx, 1), [
      "shared-mut:0x7a",
      migratorsVersion,
      vaultVersion,
      "result:0",
      "shared-mut:0xcc",
      "shared:0xc0f",
      "shared-mut:0x9001",
      "pure",
      "pure",
      "clock",
    ]);
    assert.deepEqual(
      pureBytes(tx, 1).map((bytes) => bcs.u64().parse(bytes)),
      ["5000", "0"],
    );
  });
}

test("migrateBluefin redeems the Migration and pays the creation fee coin", () => {
  const tx = new Transaction();
  const migration = productMigration(tx);
  const [creationFee] = tx.splitCoins(tx.gas, [1_000n]);
  assert.ok(creationFee);
  tx.add(
    calls.migrateBluefin({
      migration,
      memeType: MEME_B,
      quoteType: SUI,
      currency: O.currency,
      quoteCurrency: O.quoteCurrency,
      bluefinConfig: O.bluefinConfig,
      creationFee,
    }),
  );
  assert.equal(targets(tx)[1], target("bluefin", "migrate"));
  // Bluefin pools are always `Pool<Meme, Quote>`.
  assert.deepEqual(moveCallTypeArguments(tx)[1], [memeB, sui]);
  // (migration, migrators_version, venue_config, &currency, &quote_currency,
  //  &mut bluefin_config, &mut registry, vault_version, treasury, creation_fee, clock)
  assert.deepEqual(moveCallArguments(tx, 1), [
    "result:0",
    migratorsVersion,
    venueConfig(false),
    "shared:0xcc",
    "shared:0xcd",
    "shared-mut:0xbf",
    registry,
    vaultVersion,
    treasury,
    "result:1:0",
    "clock",
  ]);
});

test("Bluefin fee routes and buyback take <Meme, Quote> in Move order", () => {
  const vault = {
    memeType: MEME_B,
    quoteType: SUI,
    vault: O.vault,
    currency: O.currency,
    bluefinConfig: O.bluefinConfig,
    pool: O.pool,
  };
  // (&mut vault, migrators_version, vault_version, treasury, &mut currency,
  //  bluefin_config, &mut pool, clock)
  for (const [name, step] of [
    ["collect_fees", calls.collectBluefinFees(vault)],
    ["settle_and_apply_fee_split", calls.settleAndApplyBluefinFeeSplit(vault)],
  ] as const) {
    const tx = new Transaction();
    tx.add(step);
    assert.deepEqual(targets(tx), [target("bluefin", name)]);
    assert.deepEqual(moveCallTypeArguments(tx)[0], [memeB, sui]);
    assert.deepEqual(moveCallArguments(tx, 0), [
      "shared-mut:0x7a",
      migratorsVersion,
      vaultVersion,
      treasury,
      "shared-mut:0xcc",
      "shared:0xbf",
      "shared-mut:0x9001",
      "clock",
    ]);
  }

  const tx = new Transaction();
  tx.add(
    calls.buybackAndBurnBluefin({
      ...vault,
      adminWitness: "0x5e",
      quoteIn: 1n,
      minMemeOut: 9n,
    }),
  );
  assert.deepEqual(targets(tx), [target("bluefin", "buyback_and_burn")]);
  // (&mut vault, migrators_version, vault_version, &admin_witness, &mut currency,
  //  bluefin_config, &mut pool, quote_in, min_meme_out, clock)
  assert.deepEqual(moveCallArguments(tx, 0), [
    "shared-mut:0x7a",
    migratorsVersion,
    vaultVersion,
    "object:0x5e",
    "shared-mut:0xcc",
    "shared:0xbf",
    "shared-mut:0x9001",
    "pure",
    "pure",
    "clock",
  ]);
  assert.throws(
    () =>
      calls.buybackAndBurnBluefin({
        ...vault,
        adminWitness: "0x5e",
        quoteIn: 0n,
        minMemeOut: 0n,
      }),
    /quoteIn must be a positive u64/,
  );
});

test("MigratorTransactions signs in as BuybackAdmin before the buyback", () => {
  const txs = new MigratorTransactions(MIGRATORS);
  const tx = txs.buybackAndBurnCetus({
    memeType: MEME_A,
    quoteType: SUI,
    vault: O.vault,
    currency: O.currency,
    cetus: { config: O.cetusConfig },
    pool: O.pool,
    quoteIn: 10n,
    minMemeOut: 1n,
    adminCapId: "0xca9",
  });
  assert.deepEqual(targets(tx), [
    `${normalizeSuiAddress("0xad")}::blast_acl::sign_in`,
    target("cetus", "buyback_and_burn"),
  ]);
  assert.deepEqual(moveCallTypeArguments(tx)[0], [
    normalizeStructTag("0x1000::blast_domain::BuybackAdmin"),
  ]);
  assert.deepEqual(moveCallArguments(tx, 0), ["shared:0xac1", "object:0xca9"]);
  assert.equal(moveCallArguments(tx, 1)[3], "result:0");

  const bluefin = txs.buybackAndBurnBluefin({
    memeType: MEME_A,
    quoteType: SUI,
    vault: O.vault,
    currency: O.currency,
    bluefinConfig: O.bluefinConfig,
    pool: O.pool,
    quoteIn: 10n,
    minMemeOut: 1n,
    adminCapId: "0xca9",
  });
  assert.equal(targets(bluefin)[1], target("bluefin", "buyback_and_burn"));
  assert.equal(moveCallArguments(bluefin, 1)[3], "result:0");

  const vault = {
    memeType: MEME_A,
    quoteType: SUI,
    vault: O.vault,
    currency: O.currency,
    pool: O.pool,
  };
  const cetus = {
    ...vault,
    cetus: { config: O.cetusConfig, burnManager: O.burnManager },
  };
  const bluefinVault = { ...vault, bluefinConfig: O.bluefinConfig };
  assert.deepEqual(targets(txs.collectCetusFees(cetus)), [
    target("cetus", "collect_fees"),
  ]);
  assert.deepEqual(targets(txs.settleAndApplyCetusFeeSplit(cetus)), [
    target("cetus", "settle_and_apply_fee_split"),
  ]);
  assert.deepEqual(targets(txs.collectBluefinFees(bluefinVault)), [
    target("bluefin", "collect_fees"),
  ]);
  assert.deepEqual(targets(txs.settleAndApplyBluefinFeeSplit(bluefinVault)), [
    target("bluefin", "settle_and_apply_fee_split"),
  ]);
});

test("rejects an incomplete deployment", () => {
  assert.throws(
    () =>
      new MigratorCalls({
        ...MIGRATORS,
        venueConfig: { objectId: "0x0", initialSharedVersion: "1" },
      }),
    /migrators.venueConfig.objectId must not be the zero address/,
  );
  assert.throws(
    () =>
      new MigratorCalls({
        ...MIGRATORS,
        vault: { ...MIGRATORS.vault, registry: undefined as never },
      }),
    /vault.registry must be a shared object identity/,
  );
});

test("every classified blast_migrators builder is built and matches the frozen ABI", () => {
  coverage.assertEveryBuilder(10);
});
