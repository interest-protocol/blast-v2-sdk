import { isValidSuiObjectId, normalizeSuiObjectId } from "@mysten/sui/utils";

import { normalizePositiveU64 } from "./integers.ts";

export type SharedObjectIdentity = Readonly<{
  objectId: string;
  initialSharedVersion: number | string;
}>;

export type SharedObjectReference<Mutable extends boolean = boolean> =
  SharedObjectIdentity & {
    mutable: Mutable;
  };

export type SuiPackageReference = Readonly<{
  packageId: string;
  originalPackageId: string;
}>;

export function normalizeSharedObjectIdentity(
  name: string,
  identity: SharedObjectIdentity,
): SharedObjectIdentity {
  if (typeof identity !== "object" || identity === null) {
    throw new TypeError(`${name} must be a shared object identity`);
  }
  return {
    objectId: normalizeNonzeroSuiObjectId(
      `${name}.objectId`,
      identity.objectId,
    ),
    initialSharedVersion: normalizePositiveU64(
      `${name}.initialSharedVersion`,
      identity.initialSharedVersion,
    ),
  };
}

export function normalizeSharedObjectReference<const Mutable extends boolean>(
  name: string,
  reference: SharedObjectReference<Mutable>,
  mutable: Mutable,
): SharedObjectReference<Mutable> {
  const identity = normalizeSharedObjectIdentity(name, reference);
  if (reference.mutable !== mutable) {
    throw new TypeError(`${name}.mutable must be ${mutable}`);
  }
  return {
    ...identity,
    mutable,
  };
}

export function normalizeSuiPackageReference(
  name: string,
  reference: SuiPackageReference,
): SuiPackageReference {
  if (typeof reference !== "object" || reference === null) {
    throw new TypeError(`${name} must be a package reference`);
  }
  return {
    packageId: normalizeNonzeroSuiObjectId(
      `${name}.packageId`,
      reference.packageId,
    ),
    originalPackageId: normalizeNonzeroSuiObjectId(
      `${name}.originalPackageId`,
      reference.originalPackageId,
    ),
  };
}

function normalizeNonzeroSuiObjectId(name: string, value: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a valid Sui object ID`);
  }
  let objectId: string;
  try {
    objectId = normalizeSuiObjectId(value);
  } catch {
    throw new TypeError(`${name} must be a valid Sui object ID`);
  }
  if (!isValidSuiObjectId(objectId)) {
    throw new TypeError(`${name} must be a valid Sui object ID`);
  }
  if (BigInt(objectId) === 0n) {
    throw new RangeError(`${name} must not be the zero address`);
  }
  return objectId;
}
