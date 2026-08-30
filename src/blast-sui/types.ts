import { normalizeSuiObjectId } from "@mysten/sui/utils";

import type { SharedObjectReference } from "../lib/sui.ts";
import {
  normalizeSharedObjectReference,
  normalizeSuiPackageReference,
} from "../lib/sui.ts";

/** The package and shared-object identities needed for blast Sui calls. */
export type BlastSuiDeployment = {
  packageId: string;
  originalPackageId?: string;
  packageVersion: SharedObjectReference<false>;
  vault: SharedObjectReference<true>;
};

type NormalizedBlastSuiDeployment = Required<BlastSuiDeployment>;

/** Normalizes blast Sui identities and enforces each shared object's mutability. */
export function normalizeBlastSuiDeployment(
  deployment: BlastSuiDeployment,
): NormalizedBlastSuiDeployment {
  const packageReference = normalizeSuiPackageReference("blastSui", {
    packageId: deployment.packageId,
    originalPackageId: deployment.originalPackageId ?? deployment.packageId,
  });
  return {
    ...packageReference,
    packageVersion: normalizeSharedObjectReference(
      "packageVersion",
      deployment.packageVersion,
      false,
    ),
    vault: normalizeSharedObjectReference("vault", deployment.vault, true),
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
