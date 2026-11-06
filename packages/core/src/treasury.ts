import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { normalizeStructTag, normalizeSuiObjectId } from "@mysten/sui/utils";
import type { Proposal } from "./bcs.ts";
import { addressBcs, delayedBcs, suiUidBcs, unitKeyBcs } from "./bcs.ts";
import type { CoreDeployment } from "./deployment.ts";
import { coreType } from "./deployment.ts";
import { normalizePositiveU64 } from "./integers.ts";
import type { SharedObjectIdentity } from "./sui.ts";

/** BCS layout of `blast_core::blast_treasury::Treasury`. */
export const treasuryBcs = bcs.struct("Treasury", {
  id: suiUidBcs,
  destination: delayedBcs(unitKeyBcs, addressBcs),
});

/**
 * The one address every Blast fee is paid to: the applied `destination`, the
 * delay the next change waits, and the scheduled change, if any.
 */
export type TreasuryState = SharedObjectIdentity & {
  destination: string;
  delayMs: bigint;
  pending: Proposal<string> | null;
};

/**
 * The treasury's one delayed key, `blast_treasury::DestinationKey`
 * (`Delayed<DestinationKey, address>`), in the shape of
 * `@interest-protocol/blast-admin-sdk/events`' `DelayedKeySpecs`; decode its
 * events with `decodeDelayedEvent` and the core original package ID.
 */
export const treasuryDelayedKeys = {
  Destination: {
    key: "blast_treasury::DestinationKey",
    family: "setting",
    keyBcs: unitKeyBcs,
    valueBcs: addressBcs,
    valueType: "address",
  },
} as const;

export function decodeTreasuryObject(
  object: SharedObjectIdentity & { type: string; content: Uint8Array },
  core: Pick<CoreDeployment, "originalPackageId">,
): TreasuryState {
  if (
    normalizeStructTag(object.type) !==
    coreType(core, "blast_treasury", "Treasury")
  ) {
    throw new TypeError(`object ${object.objectId} is not the Blast treasury`);
  }
  const parsed = treasuryBcs.parse(object.content);
  const objectId = normalizeSuiObjectId(object.objectId);
  if (
    normalizeSuiObjectId(parsed.id.id.bytes) !== objectId ||
    parsed.destination.parent !== objectId
  ) {
    throw new TypeError(`treasury ${object.objectId} has a mismatched UID`);
  }
  return {
    objectId,
    initialSharedVersion: normalizePositiveU64(
      "initialSharedVersion",
      object.initialSharedVersion,
    ),
    destination: parsed.destination.value,
    delayMs: parsed.destination.delay_ms,
    pending: parsed.destination.pending,
  };
}

/** Reads the shared treasury the core deployment records. */
export async function getTreasury(
  client: ClientWithCoreApi,
  core: Pick<CoreDeployment, "originalPackageId" | "treasury">,
): Promise<TreasuryState> {
  const { object } = await client.core.getObject({
    objectId: core.treasury.objectId,
    include: { content: true },
  });
  if (object.owner.$kind !== "Shared") {
    throw new TypeError(`treasury ${object.objectId} is not a shared object`);
  }
  return decodeTreasuryObject(
    {
      objectId: object.objectId,
      initialSharedVersion: object.owner.Shared.initialSharedVersion,
      type: object.type,
      content: object.content,
    },
    core,
  );
}
