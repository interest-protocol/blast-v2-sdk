/**
 * The `blast_core` error registry (`sui/core/sources/errors.move`): a name's
 * index is its numeric abort code. Codes are package-wide, so check first
 * that the abort location's package is `blast_core`; the module is only
 * where the macro expanded.
 */
export const CORE_ABORTS = [
  "EInvalidBps",
  "EInvalidApportionment",
  "EInvalidVestingTerms",
  "EInvalidRoute",
  "EInvalidFeeSplit",
  "EInvalidTreasury",
  "EInvalidPair",
  "EPartnerMismatch",
  "EWrongVenue",
  "EWrongOwner",
  "EWrongPackageWitness",
  "EInvalidLpFeeBps",
  "EInvalidRecipient",
  "ELedgerNotEmpty",
] as const;

export type CoreAbortName = (typeof CORE_ABORTS)[number];

/** The error a `blast_core` abort `code` names; null for an unknown code. */
export function coreAbortName(code: number): CoreAbortName | null {
  return abortName(CORE_ABORTS, code);
}

/** The name at `code` in a package's numeric error registry, or null. */
export function abortName<const Names extends readonly string[]>(
  names: Names,
  code: number,
): Names[number] | null {
  return Number.isInteger(code) && code >= 0 ? (names[code] ?? null) : null;
}
