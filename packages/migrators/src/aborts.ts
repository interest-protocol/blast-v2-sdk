import { abortName } from "@interest-protocol/blast-core/aborts";

/**
 * The `blast_migrators` error registry (`sui/migrators/sources/lib/errors.move`):
 * a name's index is its numeric abort code. Codes are package-wide, so check
 * first that the abort location's package is the migrators package. A vault
 * upgrade the migrators have not followed aborts in `blast_admin` instead
 * (`EVersionMismatch`).
 */
export const MIGRATORS_ABORTS = [
  "EInvalidCoinOrder",
  "EPositionPoolMismatch",
  "EWrongCoinPair",
  "EInvalidTier",
  "ESymbolTooLong",
  "EInvalidAutoLpPrice",
] as const;

export type MigratorsAbortName = (typeof MIGRATORS_ABORTS)[number];

/** The error a `blast_migrators` abort `code` names; null for an unknown code. */
export function migratorsAbortName(code: number): MigratorsAbortName | null {
  return abortName(MIGRATORS_ABORTS, code);
}
