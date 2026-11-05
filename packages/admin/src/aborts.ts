import { abortName } from "@interest-protocol/blast-core/aborts";

/**
 * The `blast_admin` error registry (`sui/admin/sources/errors.move`): a
 * name's index is its numeric abort code. Codes are package-wide, so check
 * first that the abort location's package is the admin package.
 */
export const ADMIN_ABORTS = [
  "EInvalidSuperAdminCap",
  "EInvalidAdminCap",
  "EInvalidAdminRecipient",
  "EAdminRoleCapacityReached",
  "EAdminRoleAlreadyGranted",
  "EAdminRoleNotGranted",
  "EInvalidSuperAdminRecipient",
  "ENotPendingSuperAdminRecipient",
  "ESuperAdminCapStillActive",
  "EVersionMismatch",
  "EInvalidUpgradeCap",
  "EInvalidPackageDigest",
  "EUpgradeCapUnavailable",
  "ENotReady",
  "ENoPending",
  "EInvalidDelay",
  "EUnchanged",
  "EProposalPending",
  "EWrongChange",
  "EInvalidPauseBits",
  "EPauseUnchanged",
  "EPaused",
  "EWrongUpgradeAction",
  "EUnguardedUpgradeDelay",
  "EInvalidPackageWitness",
  "EWrongUnpauseWitness",
  "EWrongPackageWitness",
] as const;

export type AdminAbortName = (typeof ADMIN_ABORTS)[number];

/** The error a `blast_admin` abort `code` names; null for an unknown code. */
export function adminAbortName(code: number): AdminAbortName | null {
  return abortName(ADMIN_ABORTS, code);
}
