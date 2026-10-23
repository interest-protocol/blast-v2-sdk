import {
  moveTypeNameBcs,
  suiObjectIdBcs,
} from "@interest-protocol/blast-core/bcs";
import type { SuiEventPosition } from "@interest-protocol/blast-core/events";
import {
  normalizeSuiEventPosition,
  suiEventId,
} from "@interest-protocol/blast-core/events";
import type { BasisPoints } from "@interest-protocol/blast-core/integers";
import {
  requireBasisPoints,
  requireU64,
} from "@interest-protocol/blast-core/integers";
import type { BcsType } from "@mysten/sui/bcs";
import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import {
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";

type BlastSuiEventFieldDescriptor =
  | "id"
  | "address"
  | "u64"
  | "basisPoints"
  | "typeName"
  | "vaultCustody";

export const blastSuiEventSpecs = {
  BlastSuiDepositCancelled: {
    receipt_id: "id",
    vault_id: "id",
    principal_sui: "u64",
    returned_sui: "u64",
  },
  BlastSuiDepositClaimed: {
    receipt_id: "id",
    vault_id: "id",
    principal_sui: "u64",
    contributed_sui: "u64",
    pool_tokens: "u64",
    blast_out: "u64",
    custody: "vaultCustody",
  },
  BlastSuiDepositRequested: {
    receipt_id: "id",
    vault_id: "id",
    pool_id: "id",
    principal_sui: "u64",
    activation_epoch: "u64",
    custody: "vaultCustody",
  },
  BlastSuiDonated: {
    sui_in: "u64",
    custody: "vaultCustody",
  },
  BlastSuiRedeemed: {
    blast_in: "u64",
    gross_sui: "u64",
    fee_sui: "u64",
    net_sui: "u64",
    custody: "vaultCustody",
  },
  FunSuiMinted: {
    sui_in: "u64",
    custody: "vaultCustody",
  },
  FunSuiRedeemed: {
    fun_in: "u64",
    custody: "vaultCustody",
  },
  FunYieldSwept: {
    liquid_sui: "u64",
    pool_tokens: "u64",
    swept_sui: "u64",
    custody: "vaultCustody",
  },
  NativeStakeUnwound: {
    custody: "vaultCustody",
  },
  PackageCapabilityAdded: {
    package_admin_id: "id",
    capability_id: "id",
    capability_type: "typeName",
  },
  RedeemFeeChanged: {
    old_redeem_fee_bps: "basisPoints",
    new_redeem_fee_bps: "basisPoints",
  },
  VaultCreated: {
    vault_id: "id",
    validator: "address",
    pool_id: "id",
    fun_reserve_sui: "u64",
    bootstrap_sui: "u64",
    locked_blast_sui: "u64",
    redeem_fee_bps: "basisPoints",
    custody: "vaultCustody",
  },
  VaultSynced: {
    custody: "vaultCustody",
  },
} as const satisfies Record<
  string,
  Record<string, BlastSuiEventFieldDescriptor>
>;

export type BlastSuiEventKind = keyof typeof blastSuiEventSpecs;

export type PoolCustodyEvent = {
  liquid_sui: bigint;
  pending_sui: bigint;
  active_pool_tokens: bigint;
  active_sui: bigint;
};

export type ExchangeRateEvent = {
  epoch: bigint;
  sui_amount: bigint;
  pool_token_amount: bigint;
};

export type VaultCustodyEvent = {
  fun_custody: PoolCustodyEvent;
  blast_custody: PoolCustodyEvent;
  exchange_rate: ExchangeRateEvent;
  fun_supply: bigint;
  blast_supply: bigint;
};

type DescriptorOutput<Descriptor extends BlastSuiEventFieldDescriptor> =
  Descriptor extends "u64"
    ? bigint
    : Descriptor extends "basisPoints"
      ? BasisPoints
      : Descriptor extends "vaultCustody"
        ? VaultCustodyEvent
        : string;

type DescriptorInput<Descriptor extends BlastSuiEventFieldDescriptor> =
  Descriptor extends "basisPoints" ? bigint : DescriptorOutput<Descriptor>;

export type BlastSuiEventPayloads = {
  [Kind in BlastSuiEventKind]: {
    [Field in keyof (typeof blastSuiEventSpecs)[Kind]]: DescriptorOutput<
      Extract<
        (typeof blastSuiEventSpecs)[Kind][Field],
        BlastSuiEventFieldDescriptor
      >
    >;
  };
};

type BlastSuiEventPayloadInputs = {
  [Kind in BlastSuiEventKind]: {
    [Field in keyof (typeof blastSuiEventSpecs)[Kind]]: DescriptorInput<
      Extract<
        (typeof blastSuiEventSpecs)[Kind][Field],
        BlastSuiEventFieldDescriptor
      >
    >;
  };
};

const U64Bcs = bcs.u64().transform({
  input: (value: bigint) => requireU64("event u64", value),
  output: (value) => BigInt(value),
});
const BasisPointsBcs = bcs.u64().transform({
  input: (value: bigint) => requireBasisPoints("event basis points", value),
  output: (value) => requireBasisPoints("event basis points", BigInt(value)),
});
const AddressBcs = bcs.Address.transform({
  input: (value: string) => normalizeSuiAddress(value),
  output: (value) => normalizeSuiAddress(value),
});

export const poolCustodyEventBcs = bcs.struct("PoolCustody", {
  liquid_sui: U64Bcs,
  pending_sui: U64Bcs,
  active_pool_tokens: U64Bcs,
  active_sui: U64Bcs,
});

export const exchangeRateEventBcs = bcs.struct("ExchangeRate", {
  epoch: U64Bcs,
  sui_amount: U64Bcs,
  pool_token_amount: U64Bcs,
});

export const vaultCustodyEventBcs = bcs.struct("VaultCustody", {
  fun_custody: poolCustodyEventBcs,
  blast_custody: poolCustodyEventBcs,
  exchange_rate: exchangeRateEventBcs,
  fun_supply: U64Bcs,
  blast_supply: U64Bcs,
});

const BLAST_SUI_EVENT_FIELD_BCS: Record<
  BlastSuiEventFieldDescriptor,
  BcsType<unknown, unknown>
> = {
  id: suiObjectIdBcs as BcsType<unknown, unknown>,
  address: AddressBcs as BcsType<unknown, unknown>,
  u64: U64Bcs as BcsType<unknown, unknown>,
  basisPoints: BasisPointsBcs as BcsType<unknown, unknown>,
  typeName: moveTypeNameBcs as BcsType<unknown, unknown>,
  vaultCustody: vaultCustodyEventBcs as BcsType<unknown, unknown>,
};

type BlastSuiEventBcsMap = {
  [Kind in BlastSuiEventKind]: BcsType<
    BlastSuiEventPayloads[Kind],
    BlastSuiEventPayloadInputs[Kind]
  >;
};

export const blastSuiEventBcs = Object.fromEntries(
  Object.entries(blastSuiEventSpecs).map(([name, spec]) => [
    name,
    bcs.struct(
      name,
      Object.fromEntries(
        Object.entries(spec).map(([field, descriptor]) => [
          field,
          BLAST_SUI_EVENT_FIELD_BCS[descriptor],
        ]),
      ),
    ),
  ]),
) as unknown as BlastSuiEventBcsMap;

export type BlastSuiEventPackageIdentity = {
  packageId: string;
  originalPackageId: string;
};

type DecodedBlastSuiEventBase = {
  source: "blastSui";
  emitterPackageId: string;
  sender: string;
  position: SuiEventPosition;
};

export type DecodedBlastSuiEvent = {
  [Kind in BlastSuiEventKind]: DecodedBlastSuiEventBase & {
    kind: Kind;
    payload: BlastSuiEventPayloads[Kind];
  };
}[BlastSuiEventKind];

export function decodeBlastSuiEvent(
  event: SuiClientTypes.EventEntry,
  packages: BlastSuiEventPackageIdentity,
): DecodedBlastSuiEvent {
  const currentPackageId = normalizeSuiObjectId(packages.packageId);
  if (normalizeSuiObjectId(event.packageId) !== currentPackageId) {
    throw new TypeError("blast Sui event has an unexpected emitter package");
  }
  if (event.module !== "blast_events") {
    throw new TypeError("blast Sui event has an unexpected emitter module");
  }

  const originalPackageId = normalizeSuiAddress(packages.originalPackageId);
  const envelope = parseStructTag(event.eventType);
  if (
    envelope.address !== originalPackageId ||
    envelope.module !== "blast_events" ||
    envelope.name !== "Event" ||
    envelope.typeParams.length !== 1
  ) {
    throw new TypeError("blast Sui event has an unexpected event package");
  }
  const payloadTag = envelope.typeParams.at(0);
  if (
    payloadTag === undefined ||
    typeof payloadTag === "string" ||
    payloadTag.address !== originalPackageId ||
    payloadTag.module !== "events" ||
    payloadTag.typeParams.length !== 0 ||
    !Object.hasOwn(blastSuiEventSpecs, payloadTag.name)
  ) {
    throw new TypeError("blast Sui event has an unexpected payload type");
  }

  const kind = payloadTag.name as BlastSuiEventKind;
  return {
    source: "blastSui",
    kind,
    payload: blastSuiEventBcs[kind].parse(event.bcs),
    emitterPackageId: currentPackageId,
    sender: normalizeSuiAddress(event.sender),
    position: normalizeSuiEventPosition(event),
  } as DecodedBlastSuiEvent;
}

export function blastSuiEventId(event: DecodedBlastSuiEvent): string {
  return suiEventId(event.position);
}
