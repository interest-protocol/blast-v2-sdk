import {
  moveTypeNameBcs,
  suiObjectIdBcs,
  suiUidBcs,
  u64Bcs,
} from "@interest-protocol/blast-core/bcs";
import type { SuiEventPosition } from "@interest-protocol/blast-core/events";
import { normalizeSuiEventPosition } from "@interest-protocol/blast-core/events";
import { deploymentObject } from "@interest-protocol/blast-core/ptb";
import type { SharedObjectIdentity } from "@interest-protocol/blast-core/sui";
import {
  normalizeSharedObjectIdentity,
  normalizeSuiPackageReference,
} from "@interest-protocol/blast-core/sui";
import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
import type {
  Transaction,
  TransactionArgument,
  TransactionObjectInput,
  TransactionResult,
} from "@mysten/sui/transactions";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";

// The Aftermath DAO-pool vendor package `blast_aftermath_dao_presale`: an
// immutable presale venue over `blast_core` alone. Its `AdminCap` prepares a
// sale token with the `CreatePoolCapV2` of a fresh LP coin and receives the
// `VenueTicket` `blast_presale::new` redeems; anyone then migrates the funded
// sale into a 50/50 Aftermath pool wrapped in a DAO-fee pool paying the
// partner treasury. It creates no vault and is never in the `VaultRegistry`.

/**
 * The published vendor package (immutable, so both IDs are equal), its
 * `AdminCap` when known, and the Aftermath shared objects its `migrate` takes.
 */
export type AftermathDaoPresaleDeployment = {
  packageId: string;
  originalPackageId: string;
  adminCapId?: string;
  aftermath: {
    /** Aftermath AMM's shared `pool_registry::PoolRegistry`. */
    poolRegistry: SharedObjectIdentity;
    /** Aftermath DAO-fee package's shared `version::Version`. */
    daoFeeVersion: SharedObjectIdentity;
  };
};

/** Constants of `blast_aftermath_dao_presale`, mirrored for display only. */
export const AFTERMATH_DAO_FEE_BPS = 200;
/** The partner treasury: every pool's DAO fees and owner cap. */
export const AFTERMATH_DAO_TREASURY = normalizeSuiAddress(
  "0x37cf46b499f740e653644bd2f7a8ed97f248e8b3c69d5d12c97d7845a54c0cd8",
);
/** Owns every pool's LP coin, locking it forever. */
export const AFTERMATH_DAO_BURN_ADDRESS = normalizeSuiAddress("0x0");

export function normalizeAftermathDaoPresaleDeployment(
  deployment: AftermathDaoPresaleDeployment,
): AftermathDaoPresaleDeployment {
  return {
    ...normalizeSuiPackageReference("aftermathDaoPresale", deployment),
    ...(deployment.adminCapId === undefined
      ? {}
      : { adminCapId: normalizeSuiObjectId(deployment.adminCapId) }),
    aftermath: {
      poolRegistry: normalizeSharedObjectIdentity(
        "aftermathDaoPresale.aftermath.poolRegistry",
        deployment.aftermath.poolRegistry,
      ),
      daoFeeVersion: normalizeSharedObjectIdentity(
        "aftermathDaoPresale.aftermath.daoFeeVersion",
        deployment.aftermath.daoFeeVersion,
      ),
    },
  };
}

/**
 * `blast_aftermath_dao_presale` calls in Move argument order; `&mut
 * TxContext` is implicit. `PackageWitness` is always the presale's
 * `blast_presale_package::PackageWitness`, so only a `Migration` the presale
 * sealed can consume the reservation.
 */
export class AftermathDaoPresaleCalls {
  readonly deployment: AftermathDaoPresaleDeployment;
  /** `blast_aftermath_dao_presale::Venue`, the witness the `CreationPolicy` admits. */
  readonly venueType: string;
  /** The presale's package witness, `prepare`'s fourth type argument. */
  readonly packageWitnessType: string;

  constructor(
    deployment: AftermathDaoPresaleDeployment,
    presale: { originalPackageId: string },
  ) {
    this.deployment = normalizeAftermathDaoPresaleDeployment(deployment);
    this.venueType = normalizeStructTag(
      `${this.deployment.originalPackageId}::blast_aftermath_dao_presale::Venue`,
    );
    this.packageWitnessType = normalizeStructTag(
      `${normalizeSuiObjectId(presale.originalPackageId)}::blast_presale_package::PackageWitness`,
    );
  }

  /**
   * `prepare<Lp, SaleToken, Quote, PackageWitness>(admin_cap,
   * create_pool_cap)`: shares the sale token's `PoolCreation<Lp, SaleToken>`
   * and returns the `VenueTicket<SaleToken, Quote>` the same PTB passes to
   * `blast_presale::new`. The contract cannot bind `Lp` to the capability; a
   * wrong `Lp` aborts only at migration, so pass the verified
   * `AftermathLpCoin`'s `lpType` and `createPoolCapId`.
   */
  prepare(options: {
    lpType: string;
    saleTokenType: string;
    quoteType: string;
    adminCap: TransactionObjectInput;
    createPoolCap: TransactionObjectInput;
  }) {
    const typeArguments = [
      normalizeStructTag(options.lpType),
      normalizeStructTag(options.saleTokenType),
      normalizeStructTag(options.quoteType),
      this.packageWitnessType,
    ];
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: this.#target("prepare"),
        typeArguments,
        arguments: [
          tx.object(options.adminCap),
          tx.object(options.createPoolCap),
        ],
      });
  }

  /**
   * `migrate<Lp, SaleToken, Quote>(migration, pool_creation, pool_registry,
   * dao_fee_version)`: redeems the presale's `Migration` from the same PTB,
   * consumes the shared `PoolCreation` (from `PoolCreationReserved`), seeds
   * the pool, shares the DAO-fee pool and locks the LP.
   */
  migrate(options: {
    migration: TransactionArgument;
    lpType: string;
    saleTokenType: string;
    quoteType: string;
    poolCreation: SharedObjectIdentity;
  }) {
    const typeArguments = [
      normalizeStructTag(options.lpType),
      normalizeStructTag(options.saleTokenType),
      normalizeStructTag(options.quoteType),
    ];
    const { aftermath } = this.deployment;
    return (tx: Transaction): void => {
      tx.moveCall({
        target: this.#target("migrate"),
        typeArguments,
        arguments: [
          options.migration,
          deploymentObject(tx, options.poolCreation, true),
          deploymentObject(tx, aftermath.poolRegistry, true),
          deploymentObject(tx, aftermath.daoFeeVersion, false),
        ],
      });
    };
  }

  #target(functionName: string): string {
    return `${this.deployment.packageId}::blast_aftermath_dao_presale::${functionName}`;
  }
}

// === State ===

/**
 * BCS of the Aftermath AMM `pool::CreatePoolCapV2`: its UID only; the LP
 * coin's `TreasuryCap` and `CoinMetadata` are dynamic fields of it.
 */
const createPoolCapV2Bcs = bcs.struct("CreatePoolCapV2", { id: suiUidBcs });

/**
 * BCS of the shared `PoolCreation<Lp, SaleToken>`:
 * `{id, package_witness: TypeName, create_pool_cap: CreatePoolCapV2}`.
 */
export const poolCreationBcs = bcs.struct("PoolCreation", {
  id: suiUidBcs,
  package_witness: moveTypeNameBcs,
  create_pool_cap: createPoolCapV2Bcs,
});

export type PoolCreationState = {
  objectId: string;
  lpType: string;
  saleTokenType: string;
  /** The product package witness the reservation is bound to (original IDs). */
  packageWitness: string;
  createPoolCapId: string;
};

/** Decodes a `PoolCreation<Lp, SaleToken>` object of the vendor package. */
export function decodePoolCreationObject(
  object: { objectId: string; type: string; content: Uint8Array },
  deployment: Pick<AftermathDaoPresaleDeployment, "originalPackageId">,
): PoolCreationState {
  const tag = parseStructTag(object.type);
  const [lpType, saleTokenType, ...extra] = tag.typeParams;
  if (
    tag.address !== normalizeSuiAddress(deployment.originalPackageId) ||
    tag.module !== "blast_aftermath_dao_presale" ||
    tag.name !== "PoolCreation" ||
    lpType === undefined ||
    saleTokenType === undefined ||
    extra.length > 0
  ) {
    throw new TypeError(`object ${object.objectId} is not a PoolCreation`);
  }
  const parsed = poolCreationBcs.parse(object.content);
  const objectId = normalizeSuiObjectId(object.objectId);
  if (normalizeSuiObjectId(parsed.id.id.bytes) !== objectId) {
    throw new TypeError(`object ${object.objectId} has a mismatched UID`);
  }
  return {
    objectId,
    lpType: normalizeStructTag(lpType),
    saleTokenType: normalizeStructTag(saleTokenType),
    packageWitness: parsed.package_witness,
    createPoolCapId: normalizeSuiObjectId(parsed.create_pool_cap.id.id.bytes),
  };
}

/**
 * The vendor sale created in transaction `creationDigest`: its one
 * `PoolCreationReserved` (`prepare` and the sale's `new` share one PTB) and
 * the live `PoolCreation`, which `migrate` takes; `poolCreation` is null once
 * the sale migrated. Null when the transaction reserved no pool creation.
 */
export async function findPoolCreation(
  client: ClientWithCoreApi,
  options: {
    deployment: Pick<AftermathDaoPresaleDeployment, "originalPackageId">;
    creationDigest: string;
  },
): Promise<{
  poolCreationId: string;
  lpType: string;
  saleTokenType: string;
  quoteType: string;
  packageWitness: string;
  poolCreation: (PoolCreationState & SharedObjectIdentity) | null;
} | null> {
  const result = await client.core.getTransaction({
    digest: options.creationDigest,
    include: { events: true },
  });
  const transaction = result.Transaction ?? result.FailedTransaction;
  const reservedType = `${normalizeSuiAddress(options.deployment.originalPackageId)}::blast_aftermath_dao_presale::PoolCreationReserved`;
  const reservations = (transaction.events ?? []).flatMap((event) => {
    const tag = parseStructTag(event.eventType);
    const [lpType, saleTokenType, quoteType, ...extra] = tag.typeParams;
    if (
      `${tag.address}::${tag.module}::${tag.name}` !== reservedType ||
      lpType === undefined ||
      saleTokenType === undefined ||
      quoteType === undefined ||
      extra.length > 0
    )
      return [];
    return [
      {
        lpType: normalizeStructTag(lpType),
        saleTokenType: normalizeStructTag(saleTokenType),
        quoteType: normalizeStructTag(quoteType),
        payload: aftermathDaoPresaleEventBcs.PoolCreationReserved.parse(
          event.bcs,
        ),
      },
    ];
  });
  if (reservations.length > 1) {
    throw new TypeError(
      `transaction ${options.creationDigest} reserved ${reservations.length} pool creations`,
    );
  }
  const [reservation] = reservations;
  if (!reservation) return null;
  const poolCreationId = normalizeSuiObjectId(
    reservation.payload.pool_creation_id,
  );
  const { objects } = await client.core.getObjects({
    objectIds: [poolCreationId],
    include: { content: true },
  });
  const object = objects[0];
  let poolCreation: (PoolCreationState & SharedObjectIdentity) | null = null;
  if (object && !(object instanceof Error)) {
    if (object.owner.$kind !== "Shared") {
      throw new TypeError(`PoolCreation ${poolCreationId} is not shared`);
    }
    poolCreation = {
      ...decodePoolCreationObject(object, options.deployment),
      initialSharedVersion: object.owner.Shared.initialSharedVersion,
    };
    if (
      poolCreation.lpType !== reservation.lpType ||
      poolCreation.saleTokenType !== reservation.saleTokenType
    ) {
      throw new TypeError(
        `PoolCreation ${poolCreationId} does not match its reservation`,
      );
    }
  }
  return {
    poolCreationId,
    lpType: reservation.lpType,
    saleTokenType: reservation.saleTokenType,
    quoteType: reservation.quoteType,
    packageWitness: reservation.payload.package_witness,
    poolCreation,
  };
}

// === Events ===

export const aftermathDaoPresaleEventBcs = {
  PoolCreationReserved: bcs.struct("PoolCreationReserved", {
    pool_creation_id: suiObjectIdBcs,
    package_witness: moveTypeNameBcs,
  }),
  Migrated: bcs.struct("Migrated", {
    presale_id: suiObjectIdBcs,
    pool_id: suiObjectIdBcs,
    dao_fee_pool_id: suiObjectIdBcs,
    owner_cap_id: suiObjectIdBcs,
    lp_coin_id: suiObjectIdBcs,
    lp: u64Bcs,
  }),
};

export type AftermathDaoPresaleEventKind =
  keyof typeof aftermathDaoPresaleEventBcs;

export type DecodedAftermathDaoPresaleEvent = {
  [Kind in AftermathDaoPresaleEventKind]: {
    kind: Kind;
    payload: ReturnType<(typeof aftermathDaoPresaleEventBcs)[Kind]["parse"]>;
    lpType: string;
    saleTokenType: string;
    quoteType: string;
    position: SuiEventPosition;
  };
}[AftermathDaoPresaleEventKind];

/**
 * Decodes `PoolCreationReserved` (its `pool_creation_id` is what `migrate`
 * takes) and `Migrated`, both typed `<Lp, SaleToken, Quote>`.
 */
export function decodeAftermathDaoPresaleEvent(
  event: SuiClientTypes.EventEntry,
  deployment: Pick<AftermathDaoPresaleDeployment, "originalPackageId">,
): DecodedAftermathDaoPresaleEvent {
  const tag = parseStructTag(event.eventType);
  const kind = tag.name as AftermathDaoPresaleEventKind;
  const [lpType, saleTokenType, quoteType, ...extra] = tag.typeParams;
  if (
    tag.address !== normalizeSuiAddress(deployment.originalPackageId) ||
    tag.module !== "blast_aftermath_dao_presale" ||
    !Object.hasOwn(aftermathDaoPresaleEventBcs, kind) ||
    lpType === undefined ||
    saleTokenType === undefined ||
    quoteType === undefined ||
    extra.length > 0
  ) {
    throw new TypeError(`unexpected Aftermath DAO event ${event.eventType}`);
  }
  return {
    kind,
    payload: aftermathDaoPresaleEventBcs[kind].parse(event.bcs),
    lpType: normalizeStructTag(lpType),
    saleTokenType: normalizeStructTag(saleTokenType),
    quoteType: normalizeStructTag(quoteType),
    position: normalizeSuiEventPosition(event),
  } as DecodedAftermathDaoPresaleEvent;
}
