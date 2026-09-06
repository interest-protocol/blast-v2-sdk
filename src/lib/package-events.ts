import type { BcsType } from "@mysten/sui/bcs";
import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";
import { suiObjectIdBcs } from "./bcs.ts";
import type { SuiEventPosition } from "./events.ts";
import { normalizeSuiEventPosition } from "./events.ts";
import { requireU64, requireU128 } from "./integers.ts";

export type PackageEventLineage = {
  packageId: string;
  originalPackageId: string;
  historicalPackageIds?: readonly string[];
};

type Field = "id" | "address" | "u64" | "u128" | "bool";
export type PackageEventSpecs = Record<
  string,
  Record<string, Record<string, Field>>
>;
type Value<D> = D extends "u64" | "u128"
  ? bigint
  : D extends "bool"
    ? boolean
    : string;
export type PackageEventPayloads<S extends PackageEventSpecs> = {
  [M in keyof S]: {
    [N in keyof S[M]]: { [F in keyof S[M][N]]: Value<S[M][N][F]> };
  };
};
export type PackageEventBcs<S extends PackageEventSpecs> = {
  [M in keyof S]: {
    [N in keyof S[M]]: BcsType<
      PackageEventPayloads<S>[M][N],
      PackageEventPayloads<S>[M][N]
    >;
  };
};
export type DecodedPackageEvent<S extends PackageEventSpecs> = {
  [M in keyof S]: {
    [N in keyof S[M]]: {
      module: M;
      name: N;
      kind: `${Extract<M, string>}.${Extract<N, string>}`;
      payload: PackageEventPayloads<S>[M][N];
      typeArguments: string[];
      emitterPackageId: string;
      sender: string;
      position: SuiEventPosition;
    };
  }[keyof S[M]];
}[keyof S];
const fields = {
  id: suiObjectIdBcs,
  address: bcs.Address.transform({
    input: normalizeSuiAddress,
    output: normalizeSuiAddress,
  }),
  u64: bcs.u64().transform({
    input: (v: bigint) => requireU64("event u64", v),
    output: BigInt,
  }),
  u128: bcs.u128().transform({
    input: (v: bigint) => requireU128("event u128", v),
    output: BigInt,
  }),
  bool: bcs.bool(),
};
/** Shared typed codec for the two native packages; declared field order is the Move BCS order. */
export function packageEventBcs<S extends PackageEventSpecs>(
  specs: S,
): PackageEventBcs<S> {
  return Object.fromEntries(
    Object.entries(specs).map(([module, events]) => [
      module,
      Object.fromEntries(
        Object.entries(events).map(([name, descriptors]) => [
          name,
          bcs.struct(
            name,
            Object.fromEntries(
              Object.entries(descriptors).map(([field, descriptor]) => [
                field,
                fields[descriptor],
              ]),
            ),
          ),
        ]),
      ),
    ]),
  ) as PackageEventBcs<S>;
}
export function decodePackageEvent<S extends PackageEventSpecs>(
  event: SuiClientTypes.EventEntry,
  packages: PackageEventLineage,
  specs: S,
  schemas: PackageEventBcs<S>,
  genericCounts: Readonly<Record<string, number>> = {},
): DecodedPackageEvent<S> {
  const emitterPackageId = normalizeSuiObjectId(event.packageId);
  const allowedEmitters = [
    packages.packageId,
    ...(packages.historicalPackageIds ?? []),
  ];
  if (
    !allowedEmitters.some((id) => normalizeSuiObjectId(id) === emitterPackageId)
  )
    throw new TypeError("unexpected event emitter");
  const tag = parseStructTag(event.eventType);
  if (
    normalizeSuiAddress(tag.address) !==
    normalizeSuiAddress(packages.originalPackageId)
  )
    throw new TypeError("unexpected event type package");
  if (
    tag.module !== event.module ||
    !Object.hasOwn(specs, tag.module) ||
    !Object.hasOwn(specs[tag.module]!, tag.name)
  )
    throw new TypeError("unsupported event module or name");
  const kind = `${tag.module}.${tag.name}`;
  if (tag.typeParams.length !== (genericCounts[kind] ?? 0))
    throw new TypeError("unexpected event type arguments");
  const schema = (
    schemas as Record<string, Record<string, BcsType<unknown, unknown>>>
  )[tag.module]![tag.name]!;
  const payload = schema.parse(event.bcs);
  const canonical = schema.serialize(payload).toBytes();
  if (
    canonical.length !== event.bcs.length ||
    canonical.some((v, i) => v !== event.bcs[i])
  )
    throw new TypeError("noncanonical or trailing event BCS");
  return {
    module: tag.module,
    name: tag.name,
    kind,
    payload,
    typeArguments: tag.typeParams.map((type) => {
      if (typeof type === "string")
        throw new TypeError("event coin type must be a struct");
      return normalizeStructTag(type);
    }),
    emitterPackageId,
    sender: normalizeSuiAddress(event.sender),
    position: normalizeSuiEventPosition(event),
  } as DecodedPackageEvent<S>;
}
