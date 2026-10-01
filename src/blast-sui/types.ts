import { normalizeSuiObjectId } from "@mysten/sui/utils";

import type { AdminDeployment } from "../admin/transactions.ts";
import { normalizeAdminDeployment } from "../admin/transactions.ts";
import type { SharedObjectIdentity } from "../lib/sui.ts";
import {
  normalizeSharedObjectIdentity,
  normalizeSuiPackageReference,
} from "../lib/sui.ts";

/** The package and shared-object identities needed for blast Sui calls. */
export type BlastSuiDeployment = {
  packageId: string;
  originalPackageId: string;
  packageVersion: SharedObjectIdentity;
  vault: SharedObjectIdentity;
  admin: AdminDeployment;
};

/** The typed `blast_sui_domain` roles. */
export type BlastSuiAdminRole = "UpgradeAdmin" | "FeeAdmin";

/** Normalizes blast Sui package and shared-object identities. */
export function normalizeBlastSuiDeployment(
  deployment: BlastSuiDeployment,
): BlastSuiDeployment {
  return {
    ...normalizeSuiPackageReference("blastSui", deployment),
    packageVersion: normalizeSharedObjectIdentity(
      "packageVersion",
      deployment.packageVersion,
    ),
    vault: normalizeSharedObjectIdentity("vault", deployment.vault),
    admin: normalizeAdminDeployment(deployment.admin),
  };
}

/** Returns the original-package identity of the FUN_SUI coin type. */
export function funSuiType(originalPackageId: string): string {
  return `${normalizeSuiObjectId(originalPackageId)}::fun_sui::FUN_SUI`;
}

/** Returns the original-package identity of the BLAST_SUI coin type. */
export function blastSuiType(originalPackageId: string): string {
  return `${normalizeSuiObjectId(originalPackageId)}::blast_sui::BLAST_SUI`;
}

/** Returns the original-package identity of the blast Sui deposit receipt. */
export function blastSuiDepositReceiptType(originalPackageId: string): string {
  return `${normalizeSuiObjectId(originalPackageId)}::deposit_receipt::BlastSuiDepositReceipt`;
}
