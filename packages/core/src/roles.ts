import type { CoreDeployment } from "./deployment.ts";
import { coreType } from "./deployment.ts";

/**
 * `blast_core::blast_domain`'s product administration roles, one set for the
 * launchpad, the presale, the vault and the venues. Package roles (upgrade,
 * pause, unpause, cancel) are `blast_admin::package_admin`'s, generic over
 * each package's OTW.
 */
export const CORE_ROLES = [
  "TreasuryAdmin",
  "FeeAdmin",
  "ListingAdmin",
  "VenueAdmin",
  "RewardsAdmin",
  "BuybackAdmin",
  "CreatorAdmin",
  "ClaimSignerAdmin",
  "CancelAdmin",
] as const;

export type CoreRole = (typeof CORE_ROLES)[number];

/** `<core original>::blast_domain::<role>`: the `Role` an `AdminCap` signs in to. */
export function coreRoleType(
  core: Pick<CoreDeployment, "originalPackageId">,
  role: CoreRole,
): string {
  if (!CORE_ROLES.includes(role)) {
    throw new TypeError(`unknown blast_domain role ${String(role)}`);
  }
  return coreType(core, "blast_domain", role);
}
