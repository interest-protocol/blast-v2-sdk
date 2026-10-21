import type { TransactionArgument } from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import { moveResults } from "../../src/lib/ptb.ts";
import type { AftermathLpCoin } from "../../src/presale/aftermath-lp.ts";
import type { PresaleDeployment } from "../../src/presale/transactions.ts";
import { PresaleCalls } from "../../src/presale/transactions.ts";

type Shared = { objectId: string; initialSharedVersion: string };
export type Admissions = { quoteAllowed: boolean; witnessAllowed: boolean };
/** The ticket and initializer stay in one PTB; admission changes are restored atomically. */
export function nativeSaleTransaction(options: {
  deployment: PresaleDeployment;
  memeType: string;
  quoteType: string;
  treasuryCap: string;
  currency: Shared;
  lpCoin: AftermathLpCoin;
  adminCap: string;
  baseline: Admissions;
  daoFeeBps: number;
  recipient: string;
  configure: (tx: Transaction, initializer: TransactionArgument) => void;
}): Transaction {
  const { deployment: d } = options;
  const calls = new PresaleCalls(d);
  const tx = new Transaction();
  const witnessType = calls.migrationWitnessType("aftermath-native");
  const setAdmissions = (allowed: boolean) => {
    if (!options.baseline.quoteAllowed)
      tx.add(
        calls.setQuoteAllowed({
          adminWitness: tx.add(
            calls.signIn({ adminCap: options.adminCap, role: "ListingAdmin" }),
          ),
          quoteType: options.quoteType,
          allowed,
        }),
      );
    if (!options.baseline.witnessAllowed)
      tx.add(
        calls.setMigrationWitnessAllowed({
          adminWitness: tx.add(
            calls.signIn({ adminCap: options.adminCap, role: "AdapterAdmin" }),
          ),
          witnessType,
          allowed,
        }),
      );
  };
  setAdmissions(true);
  const [initializer, ticket] = moveResults(
    tx.add(calls.startNativeAftermathPresale(options)),
    2,
  );
  options.configure(tx, initializer);
  const [sale, cap, reservation] = moveResults(
    tx.add(
      calls.finalizeNativeAftermathPresale({
        ...options,
        initializer,
        ticket,
        memeCurrency: { ...options.currency, mutable: true },
      }),
    ),
    3,
  );
  tx.add(
    calls.share({
      memeType: options.memeType,
      quoteType: options.quoteType,
      presale: sale,
      startMs: 0n,
    }),
  );
  tx.add(
    calls.shareNativeAftermathPoolCreation({
      ...options,
      lpType: options.lpCoin.lpType,
      poolCreation: reservation,
    }),
  );
  tx.transferObjects([cap], options.recipient);
  setAdmissions(false);
  return tx;
}
