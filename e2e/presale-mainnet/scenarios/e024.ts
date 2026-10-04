/**
 * E2E-024: every presale creation rule, each simulated against mainnet as a
 * raw `bluefin::new` so the contract, not the SDK's client-side validation,
 * rejects it. SALE_O backs every attempt; simulations change nothing.
 */
import type { TransactionArgument } from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";

import { exec, expectAbort, single } from "../chain.ts";
import {
  ADMIN_CAP,
  client,
  DEPLOYMENT,
  deployer,
  presale,
  TEST_SUI,
  wallets,
} from "../env.ts";
import type { SaleToken } from "../sale.ts";
import { coins, newSaleToken } from "../sale.ts";

type Share = {
  recipient: string;
  bps: bigint;
  vesting?: [bigint, bigint, bigint];
};
type Eligibility =
  | { open: [bigint, bigint, bigint] }
  | { allowlisted: [number[], bigint] };
type Uncapped =
  | null
  | { eligible: [bigint, boolean] }
  | { anyone: [bigint, bigint, bigint, boolean] };

type Terms = {
  quoteType: string;
  supply: bigint;
  saleBps: bigint;
  lpBps: bigint;
  recipients: Share[];
  raise: bigint;
  raiseShares: Share[];
  durationMs: bigint;
  lpWindowMs: bigint;
  eligibility: Eligibility;
  uncapped: Uncapped;
  feeShares: Share[];
  holderBps: bigint;
  mintFirst: boolean;
};

const WEEK = 7n * 24n * 3_600_000n;
const ROOT = Array.from({ length: 32 }, (_, i) => i);

export async function e024(): Promise<void> {
  const w = wallets();
  const token = await newSaleToken("O", w.creator);
  const a = w.r1.toSuiAddress();
  const b = w.r2.toSuiAddress();
  const base: Terms = {
    quoteType: TEST_SUI,
    supply: coins(1_000_000_000),
    saleBps: 6_000n,
    lpBps: 4_000n,
    recipients: [],
    raise: coins(100),
    raiseShares: [],
    durationMs: 60_000n,
    lpWindowMs: WEEK,
    eligibility: { open: [coins(50), 4n, coins(25)] },
    uncapped: null,
    feeShares: [],
    holderBps: 10_000n,
    mintFirst: false,
  };
  const reject = (
    label: string,
    overrides: Partial<Terms>,
    module: string,
    code: number,
  ) =>
    expectAbort(
      label,
      w.creator,
      rawCreate(token, { ...base, ...overrides }, w.creator.toSuiAddress()),
      {
        module,
        code,
      },
    );

  // The well-formed baseline simulates cleanly, so each rejection below is its own rule.
  await expectNoAbort(token, base, w.creator);

  await reject(
    "supply already minted",
    { mintFirst: true },
    "blast_presale",
    17,
  );
  await reject("zero raise", { raise: 0n }, "blast_presale", 1);
  await reject(
    "token BPS short of 10,000",
    { saleBps: 5_000n },
    "blast_presale",
    2,
  );
  await reject(
    "zero LP allocation",
    { saleBps: 10_000n, lpBps: 0n },
    "blast_presale",
    2,
  );
  await reject(
    "duplicate token recipients",
    {
      saleBps: 5_000n,
      recipients: [
        { recipient: a, bps: 500n },
        { recipient: a, bps: 500n },
      ],
    },
    "blast_presale",
    2,
  );
  await reject(
    "zero-address token recipient",
    { saleBps: 5_000n, recipients: [{ recipient: "0x0", bps: 1_000n }] },
    "blast_presale",
    2,
  );
  await reject(
    "a recipient apportioned zero tokens",
    { supply: 100n, saleBps: 5_999n, recipients: [{ recipient: a, bps: 1n }] },
    "blast_presale",
    2,
  );
  await reject(
    "raise shares taking everything",
    { raiseShares: [{ recipient: a, bps: 10_000n }] },
    "blast_presale",
    26,
  );
  await reject(
    "duplicate raise recipients",
    {
      raiseShares: [
        { recipient: a, bps: 100n },
        { recipient: a, bps: 100n },
      ],
    },
    "blast_presale",
    26,
  );
  await reject(
    "a raise recipient apportioned zero",
    {
      raise: 1n,
      eligibility: { open: [1n, 1n, 1n] },
      raiseShares: [{ recipient: a, bps: 1n }],
    },
    "blast_presale",
    26,
  );
  await reject(
    "fee split short of 10,000",
    { holderBps: 9_000n },
    "blast_presale",
    18,
  );
  await reject(
    "seventeen fee recipients",
    {
      holderBps: 10_000n - 17n * 100n,
      feeShares: Array.from({ length: 17 }, (_, i) => ({
        recipient: normalizeSuiAddress(`0x${(i + 1).toString(16)}`),
        bps: 100n,
      })),
    },
    "blast_presale",
    18,
  );
  await reject(
    "a vested fee share",
    {
      holderBps: 9_000n,
      feeShares: [{ recipient: b, bps: 1_000n, vesting: [0n, 1_000n, 1n] }],
    },
    "blast_presale",
    18,
  );
  await reject(
    "an LP window under seven days",
    { lpWindowMs: WEEK - 1n },
    "blast_presale",
    3,
  );
  await reject(
    "a zero commitment window",
    { durationMs: 0n },
    "blast_presale",
    3,
  );
  await reject(
    "an open raise no full sale can reach",
    { eligibility: { open: [coins(50), 3n, coins(25)] } },
    "blast_presale",
    21,
  );
  await reject(
    "a zero minimum",
    { eligibility: { open: [coins(50), 4n, 0n] } },
    "blast_presale",
    4,
  );
  await reject(
    "a minimum above the cap",
    { eligibility: { open: [coins(10), 20n, coins(20)] } },
    "blast_presale",
    4,
  );
  await reject(
    "a 31-byte allowlist root",
    { eligibility: { allowlisted: [ROOT.slice(1), 2n] } },
    "blast_presale",
    4,
  );
  await reject(
    "an allowlist with no leaves",
    { eligibility: { allowlisted: [ROOT, 0n] } },
    "blast_presale",
    4,
  );
  await reject(
    "an uncapped phase at the window end",
    { uncapped: { eligible: [60_000n, true] } },
    "blast_presale",
    23,
  );
  await reject(
    "an open phase admitting fewer wallets than the policy",
    { uncapped: { anyone: [1_000n, 3n, coins(40), false] } },
    "blast_presale",
    23,
  );
  await reject(
    "an open phase whose minimum cannot reach the raise",
    {
      eligibility: { allowlisted: [ROOT, 2n] },
      uncapped: { anyone: [1_000n, 3n, coins(10), false] },
    },
    "blast_presale",
    21,
  );
  await reject(
    "an unseedable price",
    {
      supply: 2n,
      saleBps: 5_000n,
      lpBps: 5_000n,
      raise: 18_000_000_000_000_000_000n,
      eligibility: { allowlisted: [ROOT, 2n] },
    },
    "blast_presale",
    22,
  );

  // The same type as sale token and Quote: list SALE_O as a Quote just long enough to prove it.
  const setSaleO = (allowed: boolean) =>
    single((tx) =>
      tx.add(
        presale.call.setQuoteAllowed({
          adminCap: ADMIN_CAP,
          quoteType: token.memeType,
          allowed,
        }),
      ),
    );
  await exec("list SALE_O as a Quote", deployer(), setSaleO(true));
  try {
    await reject(
      "sale token and Quote the same type",
      { quoteType: token.memeType },
      "blast_presale",
      0,
    );
  } finally {
    await exec("delist SALE_O", deployer(), setSaleO(false));
  }
}

async function expectNoAbort(
  token: SaleToken,
  terms: Terms,
  creator: ReturnType<typeof wallets>["creator"],
) {
  const tx = rawCreate(token, terms, creator.toSuiAddress());
  tx.setSender(creator.toSuiAddress());
  const result = await client.core.simulateTransaction({
    transaction: tx,
    include: { effects: true },
  });
  if (result.$kind !== "Transaction") {
    throw new Error(
      `baseline creation should simulate cleanly: ${result.FailedTransaction.status.error?.message}`,
    );
  }
  console.log("  ✓ the baseline creation simulates cleanly");
}

/** `bluefin::new` built from raw Move calls, bypassing the SDK's validation. */
function rawCreate(
  token: SaleToken,
  terms: Terms,
  creator: string,
): Transaction {
  const tx = new Transaction();
  const pkg = DEPLOYMENT.packageId;
  const call = (
    name: string,
    args: TransactionArgument[],
    module = "blast_presale",
  ) =>
    tx.moveCall({
      target: `${pkg}::${module}::${name}`,
      arguments: args,
    })[0] as TransactionArgument;
  const bps = (value: bigint) => call("new", [tx.pure.u64(value)], "bps");
  const shares = (list: Share[]) =>
    tx.makeMoveVec({
      type: `${DEPLOYMENT.originalPackageId}::blast_presale::RecipientShare`,
      elements: list.map((share) =>
        share.vesting
          ? call("vested_recipient_share", [
              tx.pure.address(share.recipient),
              bps(share.bps),
              call(
                "vesting_terms",
                share.vesting.map((v) => tx.pure.u64(v)),
              ),
            ])
          : call("recipient_share", [
              tx.pure.address(share.recipient),
              bps(share.bps),
            ]),
      ),
    });
  const eligibility =
    "open" in terms.eligibility
      ? call(
          "open_eligibility",
          terms.eligibility.open.map((v) => tx.pure.u64(v)),
        )
      : call("allowlisted_eligibility", [
          tx.pure.vector("u8", terms.eligibility.allowlisted[0]),
          tx.pure.u64(terms.eligibility.allowlisted[1]),
        ]);
  const phaseType = `${DEPLOYMENT.originalPackageId}::blast_presale::UncappedPhase`;
  const uncapped = !terms.uncapped
    ? tx.moveCall({
        target: "0x1::option::none",
        typeArguments: [phaseType],
      })[0]
    : tx.moveCall({
        target: "0x1::option::some",
        typeArguments: [phaseType],
        arguments: [
          "eligible" in terms.uncapped
            ? call("uncapped_for_eligible", [
                tx.pure.u64(terms.uncapped.eligible[0]),
                tx.pure.bool(terms.uncapped.eligible[1]),
              ])
            : call("uncapped_for_anyone", [
                tx.pure.u64(terms.uncapped.anyone[0]),
                tx.pure.u64(terms.uncapped.anyone[1]),
                tx.pure.u64(terms.uncapped.anyone[2]),
                tx.pure.bool(terms.uncapped.anyone[3]),
              ]),
        ],
      })[0];
  const treasuryCap = tx.object(token.treasuryCap);
  if (terms.mintFirst) {
    const [minted] = tx.moveCall({
      target: "0x2::coin::mint",
      typeArguments: [token.memeType],
      arguments: [treasuryCap, tx.pure.u64(1)],
    });
    tx.transferObjects([minted as TransactionArgument], creator);
  }
  const [sale, cap] = tx.moveCall({
    target: `${pkg}::bluefin::new`,
    typeArguments: [token.memeType, terms.quoteType],
    arguments: [
      treasuryCap,
      tx.sharedObjectRef({ ...token.currency, mutable: true }),
      tx.pure.u64(terms.supply),
      bps(terms.saleBps),
      bps(terms.lpBps),
      shares(terms.recipients),
      tx.pure.bool(false),
      tx.pure.u64(terms.raise),
      shares(terms.raiseShares),
      tx.pure.u64(terms.durationMs),
      tx.pure.u64(terms.lpWindowMs),
      eligibility,
      uncapped as TransactionArgument,
      shares(terms.feeShares),
      bps(terms.holderBps),
      tx.sharedObjectRef({ ...DEPLOYMENT.creationPolicy, mutable: false }),
      tx.sharedObjectRef({ ...DEPLOYMENT.feePolicy, mutable: false }),
      tx.pure.u32(200),
      tx.pure.u64(10_000),
    ],
  });
  tx.moveCall({
    target: `${pkg}::blast_presale::share`,
    typeArguments: [token.memeType, terms.quoteType],
    arguments: [sale as TransactionArgument, tx.pure.u64(0), tx.object.clock()],
  });
  tx.transferObjects([cap as TransactionArgument], creator);
  return tx;
}
