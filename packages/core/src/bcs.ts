import type { BcsType } from "@mysten/sui/bcs";
import { bcs } from "@mysten/sui/bcs";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
} from "@mysten/sui/utils";

export const suiIdBcs = bcs.struct("ID", { bytes: bcs.Address });
export const suiUidBcs = bcs.struct("UID", { id: suiIdBcs });
export const suiBalanceBcs = bcs.struct("Balance", { value: bcs.u64() });

export const suiObjectIdBcs = suiIdBcs.transform({
  input: (value: string) => ({ bytes: normalizeSuiObjectId(value) }),
  output: (value) => normalizeSuiObjectId(value.bytes),
});

const asciiStringBcs = bcs.struct("AsciiString", {
  bytes: bcs.vector(bcs.u8()),
});

export const moveTypeNameBcs = bcs
  .struct("TypeName", { name: asciiStringBcs })
  .transform({
    input: (value: string) => ({
      name: { bytes: Array.from(new TextEncoder().encode(value)) },
    }),
    output: (value) =>
      normalizeStructTag(
        new TextDecoder().decode(Uint8Array.from(value.name.bytes)),
      ),
  });

export const u64Bcs = bcs.u64().transform({
  input: (value: bigint) => value,
  output: (value) => BigInt(value),
});

export const addressBcs = bcs.Address.transform({
  input: (value: string) => normalizeSuiAddress(value),
  output: (value) => normalizeSuiAddress(value),
});

/** Applied policy and atomic proposal; readiness never applies a value implicitly. */
export type Delayed<T> = {
  value: T;
  delay_ms: bigint;
  pending: { value: T; delay_ms: bigint; ready_at_ms: bigint } | null;
};

/** Exact proposal layout, including policy-only proposals. */
export function pendingBcs<T, Input>(value: BcsType<T, Input>) {
  return bcs.struct("Pending", {
    value,
    delay_ms: u64Bcs,
    ready_at_ms: u64Bcs,
  });
}

/** Exact `blast_admin::delayed::Delayed<T>` field order. */
export function delayedBcs<T, Input>(value: BcsType<T, Input>) {
  return bcs.struct("Delayed", {
    value,
    delay_ms: u64Bcs,
    pending: bcs.option(pendingBcs(value)),
  });
}

export type Pending<T> = NonNullable<Delayed<T>["pending"]>;

/** Admission removals are immediate; additions and notice changes require apply. */
export const migrationAdmissionFields = {
  witness_delay_ms: u64Bcs,
  pending_witness_delay: bcs.option(pendingBcs(bcs.bool())),
  pending_witnesses: bcs.vector(
    bcs.struct("Entry", {
      key: moveTypeNameBcs,
      value: pendingBcs(bcs.bool()),
    }),
  ),
};
