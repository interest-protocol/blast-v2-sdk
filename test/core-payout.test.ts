import assert from "node:assert/strict";
import test from "node:test";
import { CoreCalls } from "@interest-protocol/blast-core/deployment";
import { vaultTermsBcs } from "@interest-protocol/blast-core/migration";
import { recipientBcs } from "@interest-protocol/blast-core/payout";
import type { Ledger } from "@interest-protocol/blast-core/protocol-fees";
import {
  ledgerBcs,
  previewProtocolFeesPaid,
  protocolFeesPaidBcs,
  takeCut,
} from "@interest-protocol/blast-core/protocol-fees";
import { treasuryDelayedKeys } from "@interest-protocol/blast-core/treasury";
import type { TransactionResult } from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import { fromHex, normalizeSuiAddress, toHex } from "@mysten/sui/utils";

const id = (value: string) => normalizeSuiAddress(value);
const core = {
  packageId: "0xc02e",
  originalPackageId: "0xc0",
  treasury: { objectId: "0x7e", initialSharedVersion: "5" },
};

// Literal BCS from test/fixtures/core-vectors.move at contracts a1a8f6c9.
const RECIPIENT_VESTING =
  "000000000000000000000000000000000000000000000000000000000000beef010a0000000000000014000000000000000300000000000000";
const RECIPIENT_OUTRIGHT =
  "000000000000000000000000000000000000000000000000000000000000beef00";
const VAULT_TERMS =
  "00000000000000000000000000000000000000000000000000000000000b000157303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303a3a6d6967726174696f6e3a3a546573744973737565720500000000000000000000000000000000000000000000000000000000000000f00de80300000000000001a00f00000000000002d00700000000000003d00700000000000004e803000000000000dc05000000000000b80b000000000000010000000000000000000000000000000000000000000000000000000000000a1101";

test("Recipient decodes outright and vesting payouts in Move field order", () => {
  assert.deepEqual(recipientBcs.parse(fromHex(RECIPIENT_VESTING)), {
    destination: id("0xbeef"),
    vestingTerms: { cliffDelayMs: 10n, periodDurationMs: 20n, periods: 3n },
  });
  assert.deepEqual(recipientBcs.parse(fromHex(RECIPIENT_OUTRIGHT)), {
    destination: id("0xbeef"),
    vestingTerms: null,
  });
  assert.equal(
    toHex(
      recipientBcs
        .serialize({
          destination: "0xbeef",
          vestingTerms: {
            cliffDelayMs: 10n,
            periodDurationMs: 20n,
            periods: 3n,
          },
        })
        .toBytes(),
    ),
    RECIPIENT_VESTING,
  );
});

test("VaultTerms decodes the sealed terms with the original witness name", () => {
  assert.deepEqual(vaultTermsBcs.parse(fromHex(VAULT_TERMS)), {
    origin: id("0xb0001"),
    packageWitness: `${id("0x0")}::migration::TestIssuer`,
    feeSplit: {
      routes: [
        { destination: { kind: "Address", address: id("0xf00d") }, bps: 1000n },
        { destination: { kind: "Owner" }, bps: 4000n },
        { destination: { kind: "AutoLp" }, bps: 2000n },
        { destination: { kind: "HolderRewards" }, bps: 2000n },
        { destination: { kind: "Burn" }, bps: 1000n },
      ],
    },
    protocolMemeBps: 1500n,
    protocolQuoteBps: 3000n,
    partnerId: id("0xa11"),
    residuals: "Owner",
  });
});

test("CoreCalls.recipient wraps vesting terms in an option", () => {
  const calls = new CoreCalls(core);
  const functions = (step: (tx: Transaction) => TransactionResult) => {
    const tx = new Transaction();
    tx.add(step);
    return tx
      .getData()
      .commands.flatMap((command) =>
        command.$kind === "MoveCall"
          ? [`${command.MoveCall.module}::${command.MoveCall.function}`]
          : [],
      );
  };
  assert.deepEqual(
    functions(
      calls.recipient({
        destination: "0xbeef",
        vestingTerms: {
          cliffDelayMs: 10n,
          periodDurationMs: 20n,
          periods: 3n,
        },
      }),
    ),
    ["payout::vesting_terms", "option::some", "payout::recipient"],
  );
  assert.deepEqual(
    functions(calls.recipient({ destination: "0xbeef", vestingTerms: null })),
    ["option::none", "payout::recipient"],
  );
  assert.throws(() =>
    calls.vestingTerms({
      cliffDelayMs: 61n,
      periodDurationMs: 20n,
      periods: 3n,
    }),
  );
  assert.throws(() =>
    calls.vestingTerms({ cliffDelayMs: 0n, periodDurationMs: 0n, periods: 3n }),
  );
  assert.throws(() =>
    calls.vestingTerms({
      cliffDelayMs: 0n,
      periodDurationMs: 2n ** 62n + 1n,
      periods: 2n,
    }),
  );
});

test("previewProtocolFeesPaid pays the partner's floor, then the treasury", () => {
  const ledger: Ledger = {
    packageWitness: `${id("0xf1")}::blast_fun::PackageWitness`,
    origin: id("0xb1"),
    partnerId: id("0xa11"),
    meme: 999n,
    quote: 10n,
    sui: 0n,
  };
  assert.deepEqual(previewProtocolFeesPaid(ledger, 3000n), {
    meme_amount: 700n,
    quote_amount: 7n,
    sui_amount: 0n,
    partner_id: id("0xa11"),
    partner_meme_amount: 299n,
    partner_quote_amount: 3n,
    partner_sui_amount: 0n,
  });
  assert.equal(
    previewProtocolFeesPaid({ ...ledger, meme: 0n, quote: 0n }, 3000n),
    null,
  );
  assert.throws(() => previewProtocolFeesPaid(ledger, null), TypeError);
  assert.throws(
    () => previewProtocolFeesPaid({ ...ledger, partnerId: null }, 3000n),
    TypeError,
  );
  assert.equal(takeCut(7n, 5000n), 4n);
});

test("Ledger and ProtocolFeesPaid follow the Move field order", () => {
  const ledger: Ledger = {
    packageWitness: `${"0".repeat(63)}1::m::W`,
    origin: id("0xb1"),
    partnerId: null,
    meme: 1n,
    quote: 2n,
    sui: 3n,
  };
  const bytes = ledgerBcs.serialize(ledger).toBytes();
  assert.deepEqual(ledgerBcs.parse(bytes), {
    ...ledger,
    packageWitness: `${id("0x1")}::m::W`,
  });
  assert.deepEqual(
    Object.keys(
      protocolFeesPaidBcs.parse(
        protocolFeesPaidBcs
          .serialize({
            package_witness: `${"0".repeat(63)}1::m::W`,
            origin: id("0xb1"),
            treasury: id("0x7"),
            meme_amount: 1n,
            quote_amount: 2n,
            sui_amount: 3n,
            partner_id: null,
            partner_meme_amount: 0n,
            partner_quote_amount: 0n,
            partner_sui_amount: 0n,
          })
          .toBytes(),
      ),
    ),
    [
      "package_witness",
      "origin",
      "treasury",
      "meme_amount",
      "quote_amount",
      "sui_amount",
      "partner_id",
      "partner_meme_amount",
      "partner_quote_amount",
      "partner_sui_amount",
    ],
  );
  assert.equal(
    treasuryDelayedKeys.Destination.key,
    "blast_treasury::DestinationKey",
  );
});
