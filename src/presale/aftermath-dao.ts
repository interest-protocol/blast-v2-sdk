import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import type {
  TransactionArgument,
  TransactionObjectArgument,
  TransactionObjectInput,
  TransactionResult,
} from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  parseStructTag,
} from "@mysten/sui/utils";

import type { LaunchTypes } from "../launchpad/transactions.ts";
import { normalizeLaunchTypes } from "../launchpad/transactions.ts";
import { suiObjectIdBcs } from "../lib/bcs.ts";
import type { SuiEventPosition } from "../lib/events.ts";
import { normalizeSuiEventPosition } from "../lib/events.ts";
import { deploymentObject } from "../lib/ptb.ts";
import type { SharedObjectReference, SuiPackageReference } from "../lib/sui.ts";
import {
  normalizeSharedObjectReference,
  normalizeSuiPackageReference,
} from "../lib/sui.ts";
import type { AftermathLpCoin } from "./aftermath-lp.ts";
import { assertAftermathLpCoin } from "./aftermath-lp.ts";
import type {
  PresaleCreation,
  PresaleDeployment,
  PresalePayout,
  PresaleTermsSettings,
} from "./transactions.ts";
import { PresaleCalls } from "./transactions.ts";

// The Aftermath DAO-pool vendor package (`blast_aftermath_dao_presale`,
// contracts ADR 0104): a `blast_presale` migrator into a 50/50 Aftermath pool
// behind a DAO-fee pool that pays the partner treasury. Its pool's weights and
// fees are the module's constants, so its sales carry no pool tier (ADR 0111).

/** The published vendor package; it is immutable, so both IDs are the same. */
export type AftermathDaoPresaleDeployment = SuiPackageReference;

/** A vendor sale's types: its sale token and Quote, and its fresh Aftermath LP coin. */
export type AftermathDaoTypes = LaunchTypes & {
  /** The fresh LP coin `Lp` whose `CreatePoolCapV2` the sale's pool creation holds. */
  lpType: string;
};

export class AftermathDaoPresaleCalls {
  readonly deployment: AftermathDaoPresaleDeployment;
  readonly presale: PresaleCalls;

  constructor(
    deployment: AftermathDaoPresaleDeployment,
    presale: PresaleDeployment,
  ) {
    this.deployment = normalizeSuiPackageReference(
      "aftermathDaoPresale",
      deployment,
    );
    this.presale = new PresaleCalls(presale);
  }

  /**
   * `new` (vendor `AdminCap`): starts a sale that migrates through this
   * package and returns its `PresaleInitializer`. Configure it with
   * `presale.configurePresaleTerms`; the vendor's `finalize` sets the LP-fee
   * split.
   */
  start(
    options: LaunchTypes & {
      adminCap: TransactionObjectInput;
      treasuryCap: TransactionObjectInput;
    },
  ) {
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: this.#target("new"),
        typeArguments: this.#saleTypes(options),
        arguments: [
          tx.object(options.adminCap),
          deploymentObject(tx, this.presale.deployment.packageVersion, false),
          tx.object(options.treasuryCap),
          deploymentObject(tx, this.presale.deployment.creationPolicy, false),
          deploymentObject(tx, this.presale.deployment.feePolicy, false),
        ],
      });
  }

  /**
   * `finalize` (vendor `AdminCap`): names the treasury as the sale's only
   * LP-fee recipient, finalizes it, sends its `PresaleCap` to the treasury,
   * shares a `PoolCreation<Lp>` binding the verified LP coin's
   * `CreatePoolCapV2` to it, and returns the pending `Presale`, which the
   * same PTB must `share`. It aborts with `EWrongMigrator` for an initializer
   * another migrator started. Throws unless `lpCoin` is the
   * `AftermathLpCoin` `verifyAftermathLpCoin` returned.
   */
  finalize(
    options: LaunchTypes & {
      adminCap: TransactionObjectInput;
      initializer: TransactionArgument;
      memeCurrency: SharedObjectReference<true>;
      /** The verified fresh LP coin whose `CreatePoolCapV2` the sale binds. */
      lpCoin: AftermathLpCoin;
    },
  ) {
    const lpCoin = assertAftermathLpCoin(options.lpCoin);
    const typeArguments = [lpCoin.lpType, ...this.#saleTypes(options)];
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({
        target: this.#target("finalize"),
        typeArguments,
        arguments: [
          tx.object(options.adminCap),
          deploymentObject(tx, this.presale.deployment.packageVersion, false),
          options.initializer,
          sharedObject(tx, "memeCurrency", options.memeCurrency, true),
          tx.object(lpCoin.createPoolCapId),
        ],
      });
  }

  /**
   * `migrate` (anyone, while the sale is `Funded`): consumes the sale's
   * shared `PoolCreation<Lp>`, seeds the 50/50 Aftermath pool, wraps it in the
   * DAO-fee pool paying the treasury, and locks the LP at `0x0`.
   */
  migrate(
    options: AftermathDaoTypes & {
      presale: SharedObjectReference<true>;
      /** The sale's `PoolCreation<Lp>`, from `PoolCreationReserved`; consumed. */
      poolCreation: SharedObjectReference<true>;
      /** Aftermath's shared `PoolRegistry`. */
      poolRegistry: SharedObjectReference<true>;
      /** The Aftermath DAO-fee package's shared `Version`. */
      daoFeeVersion: SharedObjectReference<false>;
    },
  ) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: this.#target("migrate"),
        typeArguments: this.#lpTypes(options),
        arguments: [
          sharedObject(tx, "presale", options.presale, true),
          deploymentObject(tx, this.presale.deployment.packageVersion, false),
          sharedObject(tx, "poolCreation", options.poolCreation, true),
          deploymentObject(tx, this.presale.deployment.feePolicy, false),
          sharedObject(tx, "poolRegistry", options.poolRegistry, true),
          sharedObject(tx, "daoFeeVersion", options.daoFeeVersion, false),
          tx.object.clock(),
        ],
      });
    };
  }

  #target(functionName: string): string {
    return `${this.deployment.packageId}::blast_aftermath_dao_presale::${functionName}`;
  }

  #saleTypes(types: LaunchTypes): string[] {
    const { memeType, quoteType } = normalizeLaunchTypes(types);
    return [memeType, quoteType];
  }

  #lpTypes(types: AftermathDaoTypes): string[] {
    return [normalizeStructTag(types.lpType), ...this.#saleTypes(types)];
  }
}

export class AftermathDaoPresaleTransactions {
  readonly call: AftermathDaoPresaleCalls;

  constructor(
    deployment: AftermathDaoPresaleDeployment,
    presale: PresaleDeployment,
  ) {
    this.call = new AftermathDaoPresaleCalls(deployment, presale);
  }

  /**
   * One PTB, with the vendor `AdminCap`: `new`, every setter but the LP-fee
   * split (with `set_partner` when `partner` is given), the vendor's
   * `finalize`, then `share` from `startMs`. The `PresaleCap` goes to the
   * treasury inside `finalize`, so nothing is returned to the sender.
   */
  createSale(
    options: LaunchTypes &
      PresaleTermsSettings &
      Pick<PresaleCreation, "startMs"> & {
        adminCap: TransactionObjectInput;
        treasuryCap: TransactionObjectInput;
        memeCurrency: SharedObjectReference<true>;
        lpCoin: AftermathLpCoin;
      },
  ): Transaction {
    const tx = new Transaction();
    const initializer = tx.add(this.call.start(options));
    tx.add(
      this.call.presale.configurePresaleTerms({ ...options, initializer }),
    );
    const presale = tx.add(this.call.finalize({ ...options, initializer }));
    tx.add(this.call.presale.share({ ...options, presale }));
    return tx;
  }

  /**
   * `migrate`, then, on a partnered sale, `pay_protocol_fees_with_partner` in
   * the same PTB.
   */
  migrate(
    options: Parameters<AftermathDaoPresaleCalls["migrate"]>[0] & PresalePayout,
  ): Transaction {
    const tx = new Transaction();
    tx.add(this.call.migrate(options));
    const { partner } = options;
    if (partner) {
      tx.add(
        this.call.presale.payProtocolFeesWithPartner({ ...options, partner }),
      );
    }
    return tx;
  }
}

// === Events ===

const poolCreationReservedBcs = bcs.struct("PoolCreationReserved", {
  presale_id: suiObjectIdBcs,
  pool_creation_id: suiObjectIdBcs,
});

const migratedBcs = bcs.struct("Migrated", {
  presale_id: suiObjectIdBcs,
  pool_id: suiObjectIdBcs,
  dao_fee_pool_id: suiObjectIdBcs,
  owner_cap_id: suiObjectIdBcs,
  lp_coin_id: suiObjectIdBcs,
  lp: bcs.u64().transform({
    input: (value: bigint) => value,
    output: (value) => BigInt(value),
  }),
});

type AftermathDaoEventTypes = {
  lpType: string;
  memeType: string;
  quoteType: string;
  position: SuiEventPosition;
};

export type DecodedAftermathDaoPresaleEvent =
  | (AftermathDaoEventTypes & {
      kind: "PoolCreationReserved";
      payload: ReturnType<typeof poolCreationReservedBcs.parse>;
    })
  | (AftermathDaoEventTypes & {
      kind: "Migrated";
      payload: ReturnType<typeof migratedBcs.parse>;
    });

/**
 * Decodes `PoolCreationReserved` (its `pool_creation_id` is what `migrate`
 * takes) and `Migrated`, both typed `<Lp, SaleToken, Quote>`.
 */
export function decodeAftermathDaoPresaleEvent(
  event: SuiClientTypes.EventEntry,
  deployment: AftermathDaoPresaleDeployment,
): DecodedAftermathDaoPresaleEvent {
  const tag = parseStructTag(event.eventType);
  const [lpType, memeType, quoteType, ...extra] = tag.typeParams;
  const codec =
    tag.name === "PoolCreationReserved"
      ? poolCreationReservedBcs
      : tag.name === "Migrated"
        ? migratedBcs
        : null;
  if (
    tag.address !== normalizeSuiAddress(deployment.originalPackageId) ||
    tag.module !== "blast_aftermath_dao_presale" ||
    codec === null ||
    lpType === undefined ||
    memeType === undefined ||
    quoteType === undefined ||
    extra.length > 0
  ) {
    throw new TypeError(`unexpected Aftermath DAO event ${event.eventType}`);
  }
  return {
    kind: tag.name,
    payload: codec.parse(event.bcs),
    lpType: normalizeStructTag(lpType),
    memeType: normalizeStructTag(memeType),
    quoteType: normalizeStructTag(quoteType),
    position: normalizeSuiEventPosition(event),
  } as DecodedAftermathDaoPresaleEvent;
}

function sharedObject<const Mutable extends boolean>(
  tx: Transaction,
  name: string,
  reference: SharedObjectReference<Mutable>,
  mutable: Mutable,
): TransactionObjectArgument {
  return tx.sharedObjectRef(
    normalizeSharedObjectReference(name, reference, mutable),
  );
}
