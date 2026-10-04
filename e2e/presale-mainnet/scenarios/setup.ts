/**
 * Funding and E2E-004: allow the test Quote, SUI, and both venues on the
 * production CreationPolicy, proving each gate first.
 */
import type { TransactionArgument } from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";

import { balance, exec, expectAbort, single } from "../chain.ts";
import type { WalletName } from "../env.ts";
import {
  ADMIN_CAP,
  CETUS,
  deployer,
  presale,
  SUI,
  TEST_SUI,
  wallets,
} from "../env.ts";
import {
  BLUEFIN_TIER,
  CETUS_TICK_SPACING,
  coins,
  defaultTerms,
  imm,
  mintTestSui,
  mut,
  newSaleToken,
} from "../sale.ts";

const GAS_PER_WALLET = coins(0.1);
const TEST_SUI_PER_WALLET = coins(1_000_000);

/** Wallets that pay for most transactions, kept at this many MIST by `setup topup`. */
const HEAVY_TARGET = coins(0.5);

export async function setup(phase?: string): Promise<void> {
  const admin = deployer();
  const w = wallets();
  if (phase === "topup") {
    const tx = new Transaction();
    let any = false;
    for (const key of [w.creator, w.relayer]) {
      const have = await balance(key.toSuiAddress(), SUI);
      if (have >= HEAVY_TARGET) continue;
      const [coin] = tx.splitCoins(tx.gas, [HEAVY_TARGET - have]);
      tx.transferObjects([coin as TransactionArgument], key.toSuiAddress());
      any = true;
    }
    if (any) await exec("top up creator and relayer", admin, tx);
    return;
  }
  const all = Object.entries(w) as [WalletName, (typeof w)[WalletName]][];

  await fundWallets(
    admin,
    all.map(([, key]) => key.toSuiAddress()),
  );

  const policy = await presale.getCreationPolicy();
  if (policy.allowedQuotes.length || policy.allowedMigrationWitnesses.length) {
    console.log("  creation policy already configured; skipping E2E-004 gates");
    return;
  }

  // SALE_O backs every creation that is expected to abort; aborts revert, so it stays unused.
  const token = await newSaleToken("O", w.creator);
  const creation = (venue: "bluefin" | "cetus", quoteType: string) => {
    const common = {
      ...defaultTerms({}),
      memeType: token.memeType,
      quoteType,
      treasuryCap: token.treasuryCap,
      memeCurrency: mut(token.currency),
      startMs: 0n,
      capRecipient: w.creator.toSuiAddress(),
    };
    return venue === "bluefin"
      ? presale.tx.createBluefinPresale({ ...common, ...BLUEFIN_TIER })
      : presale.tx.createCetusPresale({
          ...common,
          cetusConfig: imm(CETUS.config),
          cetusPools: mut(CETUS.pools),
          tickSpacing: CETUS_TICK_SPACING,
        });
  };

  await expectAbort(
    "create with an unlisted Quote",
    w.creator,
    creation("bluefin", TEST_SUI),
    {
      module: "creation_policy",
      code: 1,
    },
  );

  const allowQuote = (quoteType: string) =>
    single((tx) =>
      tx.add(
        presale.call.setQuoteAllowed({
          adminCap: ADMIN_CAP,
          quoteType,
          allowed: true,
        }),
      ),
    );
  const allowVenue = (venue: "bluefin" | "cetus") =>
    single((tx) =>
      tx.add(
        presale.call.setMigrationWitnessAllowed({
          adminCap: ADMIN_CAP,
          venue,
          allowed: true,
        }),
      ),
    );

  await exec("allow TEST_SUI", admin, allowQuote(TEST_SUI));
  await exec("allow SUI", admin, allowQuote(SUI));
  await expectAbort("allow TEST_SUI again", admin, allowQuote(TEST_SUI), {
    module: "creation_policy",
    code: 0,
  });
  await expectAbort(
    "create with an unlisted migrator",
    w.creator,
    creation("bluefin", TEST_SUI),
    {
      module: "creation_policy",
      code: 2,
    },
  );
  await exec("allow the Bluefin migrator", admin, allowVenue("bluefin"));
  await expectAbort(
    "create a Cetus sale before Cetus is allowed",
    w.creator,
    creation("cetus", SUI),
    {
      module: "creation_policy",
      code: 2,
    },
  );
  await exec("allow the Cetus migrator", admin, allowVenue("cetus"));
  await expectAbort("allow Cetus again", admin, allowVenue("cetus"), {
    module: "creation_policy",
    code: 0,
  });

  const after = await presale.getCreationPolicy();
  console.log(
    `  creation policy: ${after.allowedQuotes.length} quotes, ${after.allowedMigrationWitnesses.length} migrators`,
  );
}

/** Tops every run wallet below half its target up with gas and TEST_SUI. */
async function fundWallets(
  admin: ReturnType<typeof deployer>,
  addresses: string[],
): Promise<void> {
  const needGas: string[] = [];
  const needQuote: string[] = [];
  for (const address of addresses) {
    if ((await balance(address, SUI)) < GAS_PER_WALLET / 2n)
      needGas.push(address);
    if ((await balance(address, TEST_SUI)) < TEST_SUI_PER_WALLET / 2n)
      needQuote.push(address);
  }
  if (needGas.length) {
    const tx = new Transaction();
    const split = tx.splitCoins(
      tx.gas,
      needGas.map(() => GAS_PER_WALLET),
    );
    for (const [i, address] of needGas.entries()) {
      tx.transferObjects([split[i] as TransactionArgument], address);
    }
    await exec(`fund ${needGas.length} wallets with gas`, admin, tx);
  }
  if (needQuote.length)
    await mintTestSui(admin, needQuote, TEST_SUI_PER_WALLET);
}
