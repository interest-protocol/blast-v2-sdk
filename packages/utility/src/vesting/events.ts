import type { BcsType } from "@mysten/sui/bcs";
import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import {
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";

import { moveTypeNameBcs, suiObjectIdBcs } from "../lib/bcs.ts";
import type { SuiEventPosition } from "../lib/events.ts";
import { normalizeSuiEventPosition, suiEventId } from "../lib/events.ts";
import { requireU64 } from "../lib/integers.ts";
import { vestingKindOfModule } from "./modules.ts";

type VestingEventFieldDescriptor =
  | "id"
  | "typeName"
  | "address"
  | "optionAddress"
  | "optionId"
  | "u64";

const claimedFields = {
  vesting_id: "id",
  coin_type: "typeName",
  beneficiary: "address",
  amount: "u64",
  released_total: "u64",
} as const;

const canceledFields = {
  vesting_id: "id",
  coin_type: "typeName",
  beneficiary: "address",
  refund_recipient: "address",
  beneficiary_amount: "u64",
  refund_amount: "u64",
  released_total: "u64",
} as const;

const closedFields = {
  vesting_id: "id",
  coin_type: "typeName",
} as const;

export const vestingEventSpecs = {
  checkpoints: {
    VestingCanceled: canceledFields,
    VestingClaimed: claimedFields,
    VestingClosed: closedFields,
    VestingCreated: {
      vesting_id: "id",
      coin_type: "typeName",
      beneficiary: "address",
      refund_recipient: "optionAddress",
      cancel_cap_id: "optionId",
      total_amount: "u64",
      checkpoint_count: "u64",
    },
  },
  linear: {
    VestingCanceled: canceledFields,
    VestingClaimed: claimedFields,
    VestingClosed: closedFields,
    VestingCreated: {
      vesting_id: "id",
      coin_type: "typeName",
      beneficiary: "address",
      refund_recipient: "optionAddress",
      cancel_cap_id: "optionId",
      total_amount: "u64",
      start_ms: "u64",
      cliff_ms: "u64",
      period_ms: "u64",
      periods: "u64",
    },
  },
} as const satisfies Record<
  string,
  Record<string, Record<string, VestingEventFieldDescriptor>>
>;

export type VestingEventModule = keyof typeof vestingEventSpecs;
export type VestingEventName =
  keyof (typeof vestingEventSpecs)[VestingEventModule];
export type VestingEventKind =
  | "linear.VestingCreated"
  | "linear.VestingClaimed"
  | "linear.VestingCanceled"
  | "linear.VestingClosed"
  | "checkpoints.VestingCreated"
  | "checkpoints.VestingClaimed"
  | "checkpoints.VestingCanceled"
  | "checkpoints.VestingClosed";

type DescriptorOutput<Descriptor extends VestingEventFieldDescriptor> =
  Descriptor extends "u64"
    ? bigint
    : Descriptor extends "optionAddress" | "optionId"
      ? string | null
      : string;

export type VestingEventPayloads = {
  [Module in VestingEventModule]: {
    [Name in keyof (typeof vestingEventSpecs)[Module]]: {
      [Field in keyof (typeof vestingEventSpecs)[Module][Name]]: DescriptorOutput<
        Extract<
          (typeof vestingEventSpecs)[Module][Name][Field],
          VestingEventFieldDescriptor
        >
      >;
    };
  };
};

const U64Bcs = bcs.u64().transform({
  input: (value: bigint) => requireU64("event u64", value),
  output: (value) => BigInt(value),
});
const AddressBcs = bcs.Address.transform({
  input: (value: string) => normalizeSuiAddress(value),
  output: (value) => normalizeSuiAddress(value),
});
const OptionalAddressBcs = bcs.option(AddressBcs);
const OptionalIdBcs = bcs.option(suiObjectIdBcs);

const VESTING_EVENT_FIELD_BCS: Record<
  VestingEventFieldDescriptor,
  BcsType<unknown, unknown>
> = {
  id: suiObjectIdBcs as BcsType<unknown, unknown>,
  typeName: moveTypeNameBcs as BcsType<unknown, unknown>,
  address: AddressBcs as BcsType<unknown, unknown>,
  optionAddress: OptionalAddressBcs as BcsType<unknown, unknown>,
  optionId: OptionalIdBcs as BcsType<unknown, unknown>,
  u64: U64Bcs as BcsType<unknown, unknown>,
};

type VestingEventBcsMap = {
  [Module in VestingEventModule]: {
    [Name in keyof (typeof vestingEventSpecs)[Module]]: BcsType<
      VestingEventPayloads[Module][Name],
      VestingEventPayloads[Module][Name]
    >;
  };
};

export const vestingEventBcs = Object.fromEntries(
  Object.entries(vestingEventSpecs).map(([module, events]) => [
    module,
    Object.fromEntries(
      Object.entries(events).map(([name, fields]) => [
        name,
        bcs.struct(
          name,
          Object.fromEntries(
            Object.entries(fields).map(([field, descriptor]) => [
              field,
              VESTING_EVENT_FIELD_BCS[
                descriptor as VestingEventFieldDescriptor
              ],
            ]),
          ),
        ),
      ]),
    ),
  ]),
) as unknown as VestingEventBcsMap;

export type VestingEventPackageIdentity = {
  packageId: string;
  originalPackageId: string;
};

type DecodedVestingEventBase = {
  source: "vesting";
  emitterPackageId: string;
  sender: string;
  position: SuiEventPosition;
};

export type DecodedVestingEvent = {
  [Module in VestingEventModule]: {
    [Name in keyof (typeof vestingEventSpecs)[Module]]: DecodedVestingEventBase & {
      module: Module;
      name: Name;
      kind: `${Module}.${Extract<Name, string>}`;
      payload: VestingEventPayloads[Module][Name];
    };
  }[keyof (typeof vestingEventSpecs)[Module]];
}[VestingEventModule];

export function decodeVestingEvent(
  event: SuiClientTypes.EventEntry,
  packages: VestingEventPackageIdentity,
): DecodedVestingEvent {
  const currentPackageId = normalizeSuiObjectId(packages.packageId);
  if (normalizeSuiObjectId(event.packageId) !== currentPackageId) {
    throw new TypeError("vesting event has an unexpected emitter package");
  }

  const tag = parseStructTag(event.eventType);
  if (
    tag.address !== normalizeSuiAddress(packages.originalPackageId) ||
    tag.typeParams.length !== 0
  ) {
    throw new TypeError("vesting event has an unexpected event package");
  }
  const module = vestingKindOfModule(tag.module);
  if (module === undefined) {
    throw new TypeError("unsupported vesting event module");
  }
  if (!Object.hasOwn(vestingEventSpecs[module], tag.name)) {
    throw new TypeError("unsupported vesting event name");
  }
  if (event.module !== tag.module) {
    throw new TypeError("vesting event has an unexpected emitter module");
  }

  const name = tag.name as VestingEventName;
  return {
    source: "vesting",
    module,
    name,
    kind: `${module}.${name}`,
    payload: vestingEventBcs[module][name].parse(event.bcs),
    emitterPackageId: currentPackageId,
    sender: normalizeSuiAddress(event.sender),
    position: normalizeSuiEventPosition(event),
  } as DecodedVestingEvent;
}

export function vestingEventId(event: DecodedVestingEvent): string {
  return suiEventId(event.position);
}
