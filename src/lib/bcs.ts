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
