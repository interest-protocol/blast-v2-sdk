/** Explicit opt-in: mainnet reads, simulations and Move inspection; never signs. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { AdminCalls } from "@interest-protocol/blast-admin-sdk/transactions";
import { buildAllowlist } from "@interest-protocol/blast-presale-sdk/allowlist";
import { PresaleClient } from "@interest-protocol/blast-presale-sdk/client";
import {
  allowlistedEligibility,
  openEligibility,
  uncappedForAnyone,
  uncappedForEligible,
} from "@interest-protocol/blast-presale-sdk/math";
import {
  PresaleCalls,
  PresaleTransactions,
} from "@interest-protocol/blast-presale-sdk/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { VENUE_LINEAGE } from "../test/fixtures/venue-deployment.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("../test/fixtures/presale-mainnet-versioned.json", import.meta.url),
    "utf8",
  ),
);
const modules = JSON.parse(
  readFileSync(
    new URL("../abi/production-presale-v1.json", import.meta.url),
    "utf8",
  ),
).packages.presale.modules;
const client = new SuiGrpcClient({
  network: "mainnet",
  baseUrl: process.env.SUI_GRPC_URL ?? "https://fullnode.mainnet.sui.io:443",
});
const { deployment, sender, adminSender, adminCap, superAdminCap } = fixture;
const sdk = new PresaleClient(client, deployment);
const admin = new AdminCalls(deployment.admin);
const sui = "0x2::sui::SUI";
const frozenBuilders = Object.entries(modules).flatMap(([module, abi]) =>
  abi.functions
    .filter((f) => ["builder", "compositional"].includes(f.sdk))
    .map((fn) => ({ module, fn })),
);

function body(type, parameters) {
  if (typeof type === "string") return { $kind: type };
  if (type.vector)
    return { $kind: "vector", vector: body(type.vector, parameters) };
  if (type.NamedTypeParameter) {
    const index = parameters.findIndex(
      (p) => p.name === type.NamedTypeParameter,
    );
    assert.notEqual(index, -1);
    return { $kind: "typeParameter", index };
  }
  const datatype = type.Datatype;
  assert.ok(datatype, `unknown ABI descriptor ${JSON.stringify(type)}`);
  const address = fixture.addresses[datatype.module.address];
  assert.ok(address, `missing address ${datatype.module.address}`);
  return {
    $kind: "datatype",
    datatype: {
      typeName: `${normalizeSuiAddress(address)}::${datatype.module.name}::${datatype.name}`,
      typeParameters: datatype.type_arguments.map((t) =>
        body(t.argument, parameters),
      ),
    },
  };
}
function signature(type, parameters) {
  return type.Reference
    ? {
        reference: type.Reference[0] ? "mutable" : "immutable",
        body: body(type.Reference[1], parameters),
      }
    : { reference: null, body: body(type, parameters) };
}

for (const { module, fn } of frozenBuilders) {
  test(`live ABI: ${module}::${fn.name}`, async () => {
    const { function: live } = await client.core.getMoveFunction({
      packageId: deployment.packageId,
      moduleName: module,
      name: fn.name,
    });
    assert.equal(live.visibility, "public");
    assert.equal(live.isEntry, fn.entry);
    assert.deepEqual(
      live.typeParameters,
      fn.typeParameters.map((p) => ({
        isPhantom: p.phantom,
        constraints: p.constraints.map((c) => c.toLowerCase()),
      })),
    );
    assert.deepEqual(
      live.parameters,
      fn.parameters.map((p) => signature(p, fn.typeParameters)),
    );
    assert.deepEqual(
      live.returns,
      fn.returns.map((p) => signature(p, fn.typeParameters)),
    );
  });
}

async function object(id) {
  return (
    await client.core.getObject({ objectId: id, include: { json: true } })
  ).object;
}
async function shared(id, mutable = true) {
  const value = await object(id);
  assert.equal(value.owner.$kind, "Shared");
  return {
    objectId: id,
    initialSharedVersion: value.owner.Shared.initialSharedVersion,
    mutable,
  };
}
async function simulate(tx, who = sender, checksEnabled = true) {
  tx.setSender(who);
  tx.setGasBudget(100_000_000);
  const result = await client.core.simulateTransaction({
    transaction: tx,
    checksEnabled,
    include: { effects: true, events: true },
  });
  return result.Transaction ?? result.FailedTransaction;
}
async function rejects(tx, module, code, who = sender) {
  const result = await simulate(tx, who);
  assert.equal(result.status.success, false);
  const abort = result.status.error?.MoveAbort;
  assert.ok(abort, JSON.stringify(result.status));
  assert.equal(abort.location.package, deployment.packageId);
  assert.equal(abort.location.module, module);
  assert.equal(abort.cleverError?.errorCode ?? Number(abort.abortCode), code);
  assert.equal(result.events.length, 0);
}
function grant(tx, role) {
  tx.add(
    admin.grantRole({
      superAdminCap,
      adminCapId: adminCap,
      role: sdk.call.roleType(role),
    }),
  );
  return tx.add(sdk.call.signIn({ adminCap, role }));
}
const fees = {
  raiseBps: 100n,
  tokenBps: 100n,
  lpFeeMemeBps: 100n,
  lpFeeQuoteBps: 100n,
};
const initial = new Map();

test("live deployment: shared identities, activation and closed admission", async () => {
  for (const [key, identity] of Object.entries(deployment)) {
    if (!identity?.objectId) continue;
    const ref = await shared(identity.objectId, false);
    assert.equal(ref.initialSharedVersion, identity.initialSharedVersion, key);
    initial.set(identity.objectId, (await object(identity.objectId)).digest);
  }
  initial.set(
    deployment.admin.acl.objectId,
    (await object(deployment.admin.acl.objectId)).digest,
  );
  for (const token of [
    fixture.unregulatedToken,
    ...Object.values(fixture.regulatedTokens),
  ]) {
    for (const id of [token.treasuryCap, token.currency.objectId])
      initial.set(id, (await object(id)).digest);
  }
  const unusedCurrency = await object(
    fixture.unregulatedToken.currency.objectId,
  );
  assert.equal(unusedCurrency.json.regulated["@variant"], "Unregulated");
  assert.equal(unusedCurrency.json.supply["@variant"], "Unknown");
  const version = await object(deployment.packageVersion.objectId);
  assert.equal(
    version.type,
    `${deployment.originalPackageId}::blast_presale_package::PackageVersion`,
  );
  assert.equal(version.json.generation.generation, "1");
  const policy = await sdk.getCreationPolicy();
  assert.deepEqual(policy.allowedQuotes, []);
  assert.deepEqual(policy.allowedMigrationWitnesses, []);
  const policyFees = await sdk.getFeePolicy();
  assert.equal(policyFees.destination, sender);
});

for (const [name, action] of [
  [
    "setProtocolFees",
    (tx, witness) =>
      tx.add(sdk.call.setProtocolFees({ adminWitness: witness, fees })),
  ],
  [
    "setProtocolDestination",
    (tx, witness) =>
      tx.add(
        sdk.call.setProtocolDestination({
          adminWitness: witness,
          destination: adminSender,
        }),
      ),
  ],
  [
    "setQuoteAllowed",
    (tx, witness) => {
      tx.add(
        sdk.call.setQuoteAllowed({
          adminWitness: witness,
          quoteType: sui,
          allowed: true,
        }),
      );
      tx.add(
        sdk.call.setQuoteAllowed({
          adminWitness: witness,
          quoteType: sui,
          allowed: false,
        }),
      );
    },
  ],
  [
    "setMigrationWitnessAllowed",
    (tx, witness) => {
      for (const venue of ["cetus", "bluefin"]) {
        tx.add(
          sdk.call.setMigrationWitnessAllowed({
            adminWitness: witness,
            venue,
            allowed: true,
          }),
        );
        tx.add(
          sdk.call.setMigrationWitnessAllowed({
            adminWitness: witness,
            venue,
            allowed: false,
          }),
        );
      }
    },
  ],
]) {
  test(`live simulation succeeds: ${name}`, async () => {
    const roles = {
      setProtocolFees: "FeeAdmin",
      setProtocolDestination: "TreasuryAdmin",
      setQuoteAllowed: "ListingAdmin",
      setMigrationWitnessAllowed: "AdapterAdmin",
    };
    const tx = new Transaction();
    action(tx, grant(tx, roles[name]));
    const result = await simulate(tx, adminSender);
    assert.equal(result.status.success, true, JSON.stringify(result.status));
    assert.ok(result.events.length > 1);
  });
}

for (const [kind, id] of Object.entries(fixture.cancelledSales)) {
  test(`live lifecycle builders: ${kind} cancelled sale`, async (t) => {
    const presale = await shared(id);
    const options = {
      presale,
      memeType: `${fixture.fixturePackage}::admission_tokens::${kind}`,
      quoteType: sui,
    };
    const state = await sdk.getPresale(id);
    assert.equal(state.lifecycle, "Cancelled");
    assert.equal(await sdk.getCommitment(id, sender), null);
    await t.test("settle", () =>
      rejects(sdk.tx.settle(options), "blast_presale", 5),
    );
    await t.test("cancelUnlaunched", () =>
      rejects(sdk.tx.cancelUnlaunched(options), "blast_presale", 5),
    );
    await t.test("claim", () =>
      rejects(
        sdk.tx.claim({ ...options, participants: [sender] }),
        "blast_presale",
        14,
      ),
    );
    for (const route of ["open", "allowlisted", "uncapped"]) {
      await t.test(`commit ${route}`, () =>
        rejects(
          sdk.tx.commit({
            ...options,
            route,
            amount: 1n,
            recipient: sender,
            allowlist: { index: 0n, wallet: sender, walletCap: 1n, proof: [] },
          }),
          "blast_presale",
          5,
        ),
      );
    }
    await t.test("setPresaleProtocolFees", async () => {
      const tx = new Transaction();
      tx.add(
        sdk.call.setPresaleProtocolFees({
          ...options,
          fees,
          adminWitness: grant(tx, "FeeAdmin"),
        }),
      );
      await rejects(tx, "blast_presale", 5, adminSender);
    });
  });
}

test("live simulation rejects a non-version object at argument 1", async () => {
  const wrong = new PresaleTransactions({
    ...deployment,
    packageVersion: deployment.feePolicy,
  });
  const tx = wrong.settle({
    memeType: `${fixture.fixturePackage}::admission_tokens::Fixed`,
    quoteType: sui,
    presale: await shared(fixture.cancelledSales.Fixed),
  });
  const result = await simulate(tx);
  assert.equal(result.status.success, false);
  assert.deepEqual(result.status.error.CommandArgumentError, {
    argument: 1,
    name: "TypeMismatch",
  });
  assert.equal(result.status.error.command, 0);
  assert.equal(result.events.length, 0);
});

// These creation inspections combine publisher-owned test treasuries and the
// root-owned admin capability. Ownership checks must be disabled for that
// composite fixture. They test Move execution, not transaction authorization.
function creationTransaction(venue, token, mode) {
  const tx = new Transaction();
  tx.add(
    sdk.call.setQuoteAllowed({
      adminWitness: grant(tx, "ListingAdmin"),
      quoteType: sui,
      allowed: true,
    }),
  );
  tx.add(
    sdk.call.setMigrationWitnessAllowed({
      adminWitness: grant(tx, "AdapterAdmin"),
      venue,
      allowed: true,
    }),
  );
  const allowlist = buildAllowlist([
    { wallet: adminSender, walletCap: 1_000_000n },
  ]);
  const vesting = { cliffMs: 0n, periodMs: 1000n, periods: 10n };
  const options = {
    memeType: token.memeType,
    quoteType: sui,
    treasuryCap: token.treasuryCap,
    memeCurrency: token.currency,
    tokenSupply: 1_000_000_000n,
    tokenAllocationBps: 5000n,
    liquidityTokenAllocationBps: 4000n,
    recipientAllocations: [
      {
        recipient: sender,
        bps: 1000n,
        ...(mode === "vesting" ? { vesting } : {}),
      },
    ],
    participantVesting: mode === "vesting" ? vesting : null,
    burnable: mode === "burn-only",
    raiseTarget: 1_000_000n,
    raiseAllocations: [
      {
        recipient: sender,
        bps: 1000n,
        ...(mode === "vesting" ? { vesting } : {}),
      },
    ],
    durationMs: 60_000n,
    liquidityWindowMs: 604_800_000n,
    eligibility:
      mode === "allowlisted"
        ? allowlistedEligibility(allowlist.root, allowlist.leafCount)
        : openEligibility(1_000_000n, 1n, 1_000_000n),
    uncapped:
      mode === "allowlisted"
        ? uncappedForEligible(1000n)
        : uncappedForAnyone(1000n, 1n, 1_000_000n),
    hardCap: { startsAfterMs: 1000n, closesWhenFilled: true },
    feeRecipients: [{ recipient: sender, bps: 9000n }],
    holderRewardsBps: 1000n,
    tickSpacing: venue === "cetus" ? 200 : 10,
    feeRate: 1000n,
    cetusConfig: {
      ...VENUE_LINEAGE.sharedObjects.cetus.config,
      mutable: false,
    },
    cetusPools: { ...VENUE_LINEAGE.sharedObjects.cetus.pools, mutable: true },
  };
  const created = tx.add(
    venue === "cetus"
      ? sdk.call.newCetusPresale(options)
      : sdk.call.newBluefinPresale(options),
  );
  tx.add(
    sdk.call.setPresaleProtocolFees({
      ...options,
      presale: created[0],
      adminWitness: grant(tx, "FeeAdmin"),
      fees,
    }),
  );
  tx.add(sdk.call.share({ ...options, presale: created[0], startMs: 0n }));
  tx.transferObjects([created[1]], adminSender);
  return tx;
}
for (const venue of ["cetus", "bluefin"]) {
  for (const mode of ["fixed", "burn-only", "allowlisted", "vesting"]) {
    test(`live Move inspection: ${venue} creation, ${mode}`, async () => {
      const result = await simulate(
        creationTransaction(venue, fixture.unregulatedToken, mode),
        adminSender,
        false,
      );
      assert.equal(result.status.success, true, JSON.stringify(result.status));
      const events = result.events.map((e) => e.eventType);
      for (const name of [
        "PresaleCreated",
        "ProtocolFeesChanged",
        "PresaleOpened",
      ])
        assert.ok(
          events.some((type) => type.includes(`::${name}<`)),
          name,
        );
    });
  }
  for (const [kind, token] of Object.entries(fixture.regulatedTokens)) {
    test(`live Move inspection: ${venue} rejects ${kind}`, async () => {
      const result = await simulate(
        creationTransaction(venue, token, "fixed"),
        adminSender,
        false,
      );
      const abort = result.status.error?.MoveAbort;
      assert.equal(result.status.success, false);
      assert.equal(abort?.location.package, deployment.packageId);
      assert.equal(abort?.location.module, "blast_presale");
      assert.equal(
        abort?.cleverError?.errorCode,
        35,
        JSON.stringify(result.status),
      );
      assert.equal(result.events.length, 0);
    });
  }
}

// Exercise the existing real builder assertions and fail when a public method or
// core ABI builder is added without a test. The live ABI checks above bind those
// offline construction assertions to this exact deployed package.
const covered = new Set();
const methodCoverage = new Map();
const originalMoveCall = Transaction.prototype.moveCall;
Transaction.prototype.moveCall = function (options) {
  const target =
    options.target ??
    `${options.package}::${options.module}::${options.function}`;
  const [pkg, module, fn] = target.split("::");
  if (normalizeSuiAddress(pkg) === normalizeSuiAddress("0x5f"))
    covered.add(`${module}::${fn}`);
  return originalMoveCall.call(this, options);
};
for (const Class of [PresaleCalls, PresaleTransactions]) {
  const names = Object.getOwnPropertyNames(Class.prototype).filter(
    (name) => name !== "constructor",
  );
  const seen = new Set();
  methodCoverage.set(Class.name, { names, seen });
  for (const name of names) {
    const original = Class.prototype[name];
    Class.prototype[name] = function (...args) {
      seen.add(name);
      return original.apply(this, args);
    };
  }
}
await import("../test/presale-transactions.test.ts");
await import("../test/presale-aftermath.test.ts");
await import("../test/aftermath-dao-presale.test.ts");

after(async (t) => {
  Transaction.prototype.moveCall = originalMoveCall;
  assert.deepEqual(
    frozenBuilders
      .map(({ module, fn }) => `${module}::${fn.name}`)
      .filter((name) => !covered.has(name)),
    [],
    "core functions without construction tests",
  );
  for (const [name, { names, seen }] of methodCoverage) {
    assert.deepEqual(
      names.filter((method) => !seen.has(method)),
      [],
      `untested ${name} methods`,
    );
  }
  t.diagnostic(
    `${frozenBuilders.length} core functions and ${[...methodCoverage.values()].reduce((n, v) => n + v.names.length, 0)} public SDK methods covered`,
  );
  for (const [id, digest] of initial)
    assert.equal((await object(id)).digest, digest, `simulation changed ${id}`);
});
