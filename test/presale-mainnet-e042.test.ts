import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import type { SuiClientTypes } from "@mysten/sui/client";
import type { TransactionArgument } from "@mysten/sui/transactions";
import { nativeSaleTransaction } from "../e2e/presale-mainnet/native-sale.ts";
import {
  assertFinalizeTicketAbi,
  assertStateTarget,
  PRIOR_EVIDENCE,
  parseConfig,
  targetFingerprint,
} from "../e2e/presale-mainnet/target.ts";
import { verifiedLpCoin } from "./aftermath-lp.ts";

const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
test("scenario recovery reconciles role grants and migrations after an interrupted submission", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      "--test",
      "--test-reporter=tap",
      new URL("./fixtures/e042-recovery.ts", import.meta.url).pathname,
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    },
  );
  assert.match(output, /# pass 2\b/);
});
const shared = (n: number) => ({ objectId: id(n), initialSharedVersion: "1" });
const deployment = {
  packageId: id(100),
  originalPackageId: id(100),
  packageVersion: shared(101),
  creationPolicy: shared(102),
  feePolicy: shared(103),
  venueConfig: shared(104),
  admin: { packageId: id(105), acl: shared(106) },
};
const config = {
  schemaVersion: 1,
  contractsCommit: "a".repeat(40),
  publicationDigest: "3uBTxzBbkq1SrKwtEK4aZNzzG5qsbG3RXSLNcjeG5KgH",
  deployment,
  superAdminCap: id(120),
  testkit: id(121),
  saleTokenLetter: "F",
  operators: { deployer: id(122), administrator: id(123) },
  feeRecipient: id(124),
};
function nested(arg: TransactionArgument | undefined) {
  assert.ok(arg && typeof arg === "object" && arg.$kind === "NestedResult");
  return arg.NestedResult;
}
const lpCoin = await verifiedLpCoin(`${id(113)}::af_lp::AF_LP`, id(114));
function sale(baseline = { quoteAllowed: false, witnessAllowed: false }) {
  return nativeSaleTransaction({
    deployment,
    memeType: `${id(110)}::sale_tokens::SALE_F`,
    quoteType: "0x2::sui::SUI",
    treasuryCap: id(111),
    currency: shared(112),
    lpCoin,
    adminCap: id(115),
    baseline,
    daoFeeBps: 200,
    recipient: id(116),
    configure: (tx, initializer) => {
      tx.moveCall({
        target: `${id(100)}::blast_presale::set_token_supply`,
        arguments: [initializer, tx.pure.u64(100)],
      });
    },
  }).getData();
}
test("native creation threads new's two results and shares both final objects", () => {
  const { commands } = sale();
  const newIndex = commands.findIndex(
    (c) => c.MoveCall?.module === "aftermath" && c.MoveCall.function === "new",
  );
  const finalizeIndex = commands.findIndex(
    (c) => c.MoveCall?.function === "finalize",
  );
  const finalize = commands[finalizeIndex]?.MoveCall;
  assert.ok(finalize);
  assert.deepEqual(nested(finalize.arguments[0]), [newIndex, 0]);
  assert.deepEqual(nested(finalize.arguments[2]), [newIndex, 1]);
  assert.equal(finalize.arguments.length, 5);
  const shares = commands.flatMap((c) =>
    c.MoveCall?.function === "share" ? [c.MoveCall] : [],
  );
  assert.deepEqual(
    shares.map((c) => nested(c.arguments[0])),
    [
      [finalizeIndex, 0],
      [finalizeIndex, 2],
    ],
  );
  assert.deepEqual(
    nested(
      commands.find((c) => c.TransferObjects)?.TransferObjects?.objects[0],
    ),
    [finalizeIndex, 1],
  );
});
test("temporary admissions surround creation and restore their baseline in the same PTB", () => {
  for (const baseline of [
    { quoteAllowed: false, witnessAllowed: false },
    { quoteAllowed: true, witnessAllowed: false },
    { quoteAllowed: false, witnessAllowed: true },
    { quoteAllowed: true, witnessAllowed: true },
  ]) {
    const data = sale(baseline);
    const newIndex = data.commands.findIndex(
      (c) => c.MoveCall?.function === "new",
    );
    const shareIndex = data.commands.findLastIndex(
      (c) => c.MoveCall?.function === "share",
    );
    for (const [name, alreadyAllowed] of [
      ["set_quote_allowed", baseline.quoteAllowed],
      ["set_migration_witness_allowed", baseline.witnessAllowed],
    ] as const) {
      const changes = data.commands.flatMap((c, index) =>
        c.MoveCall?.function === name ? [{ call: c.MoveCall, index }] : [],
      );
      assert.equal(changes.length, alreadyAllowed ? 0 : 2);
      if (!alreadyAllowed) {
        assert.ok(
          (changes[0]?.index ?? Infinity) < newIndex &&
            (changes[1]?.index ?? -1) > shareIndex,
        );
        const bools = changes.map((c) => {
          const input = c.call.arguments.at(-1);
          assert.ok(input?.$kind === "Input");
          return data.inputs[input.Input]?.Pure?.bytes;
        });
        assert.deepEqual(bools, ["AQ==", "AA=="]);
      }
    }
  }
});
function datatype(
  name: string,
  indexes: number[] = [],
): SuiClientTypes.OpenSignature {
  return {
    reference: null,
    body: {
      $kind: "datatype",
      datatype: {
        typeName: `${id(100)}::${name}`,
        typeParameters: indexes.map((index) => ({
          $kind: "typeParameter",
          index,
        })),
      },
    },
  };
}
function abi() {
  const base = {
    packageId: id(100),
    moduleName: "aftermath",
    visibility: "public",
    isEntry: false,
  } as const;
  const generic = { constraints: [], isPhantom: false };
  const create: SuiClientTypes.FunctionResponse = {
    ...base,
    name: "new",
    typeParameters: [generic, generic],
    parameters: [],
    returns: [
      datatype("blast_presale::PresaleInitializer", [0, 1]),
      datatype("aftermath::FinalizeTicket", [0, 1]),
    ],
  };
  const finalize: SuiClientTypes.FunctionResponse = {
    ...base,
    name: "finalize",
    typeParameters: [generic, generic, generic],
    parameters: [
      datatype("blast_presale::PresaleInitializer", [1, 2]),
      datatype("blast_presale_package::PackageVersion"),
      datatype("aftermath::FinalizeTicket", [1, 2]),
      datatype("currency::Currency"),
      datatype("pool::CreatePoolCapV2"),
      datatype("tx_context::TxContext"),
    ],
    returns: [
      datatype("blast_presale::Presale"),
      datatype("blast_presale::PresaleCap"),
      datatype("aftermath::PoolCreation"),
    ],
  };
  return { create, finalize };
}
test("ABI gate accepts the final ticket and rejects the old single-result ABI", () => {
  const { create, finalize } = abi();
  assert.doesNotThrow(() => assertFinalizeTicketAbi(id(100), create, finalize));
  assert.throws(
    () =>
      assertFinalizeTicketAbi(
        id(100),
        { ...create, returns: create.returns.slice(0, 1) },
        finalize,
      ),
    /FinalizeTicket ABI/,
  );
  assert.throws(
    () =>
      assertFinalizeTicketAbi(id(100), create, {
        ...finalize,
        parameters: finalize.parameters.filter((_, i) => i !== 2),
      }),
    /FinalizeTicket ABI/,
  );
  assert.throws(
    () =>
      assertFinalizeTicketAbi(id(100), create, {
        ...finalize,
        parameters: finalize.parameters.map((sig, i) =>
          i === 2 ? datatype("aftermath::FinalizeTicket", [0, 1]) : sig,
        ),
      }),
    /generic arguments/,
  );
  assert.throws(
    () => assertFinalizeTicketAbi(id(999), create, finalize),
    /FinalizeTicket ABI/,
  );
});
test("explicit final configuration and state binding reject stale targets", () => {
  assert.throws(
    () => parseConfig({ presale: { package: id(100) } }),
    /legacy records/,
  );
  assert.throws(
    () => parseConfig({ ...config, contractsCommit: "SET_FINAL_COMMIT" }),
    /exact published/,
  );
  const parsed = parseConfig(config);
  const fingerprint = targetFingerprint(parsed);
  assert.doesNotThrow(() =>
    assertStateTarget({ target: fingerprint }, fingerprint),
  );
  assert.throws(
    () => assertStateTarget({}, fingerprint),
    /different deployment/,
  );
  const other = targetFingerprint({
    ...parsed,
    deployment: {
      ...parsed.deployment,
      packageId: id(200),
      originalPackageId: id(200),
    },
  });
  assert.throws(
    () => assertStateTarget({ target: fingerprint }, other),
    /different deployment/,
  );
  assert.equal(
    targetFingerprint(parseConfig(JSON.parse(JSON.stringify(parsed)))),
    fingerprint,
  );
});
test("prior evidence retains its actual coverage", () => {
  assert.equal(PRIOR_EVIDENCE.length, 3);
  assert.match(PRIOR_EVIDENCE[0].scope, /vendor/);
  assert.match(PRIOR_EVIDENCE[1].scope, /predates FinalizeTicket/);
  assert.match(PRIOR_EVIDENCE[2].scope, /not signed lifecycles/);
});

test("journal recovers signed bytes and receipts across a restart and reserves gas before new work", async () => {
  const { mkdtempSync, rmSync, readdirSync, statSync } = await import(
    "node:fs"
  );
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { TransactionJournal } = await import(
    "../e2e/presale-mainnet/journal.ts"
  );
  const directory = mkdtempSync(join(tmpdir(), "e042-journal-"));
  try {
    type Receipt = {
      effects: { gasUsed: { computationCost: string; storageCost: string } };
      bytes: Uint8Array;
    };
    const state = join(directory, "state.local.json");
    const signed = { transaction: "AQID", signatures: ["signature"] };
    const journal = new TransactionJournal<Receipt>(state, "target-a");
    journal.reserve(100n, 200n);
    journal.write("create", signed);
    const restarted = new TransactionJournal<Receipt>(state, "target-a");
    assert.deepEqual(restarted.read("create"), signed);
    assert.throws(
      () => restarted.reserve(100n, 200n),
      /unresolved signed transaction/,
    );
    assert.equal(
      new TransactionJournal<Receipt>(state, "target-b").read("create"),
      undefined,
    );
    const executed = {
      effects: { gasUsed: { computationCost: "50", storageCost: "25" } },
      bytes: Uint8Array.from([0, 1, 255]),
    };
    restarted.write("create", { ...signed, executed });
    assert.deepEqual(journal.read("create")?.executed, executed);
    assert.doesNotThrow(() => journal.reserve(100n, 175n));
    assert.throws(
      () => journal.reserve(100n, 174n),
      /budget exhausted before signing/,
    );
    for (const file of readdirSync(journal.directory))
      assert.equal(statSync(join(journal.directory, file)).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
