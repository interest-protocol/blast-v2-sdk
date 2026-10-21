import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
import { ObjectError } from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
} from "@mysten/sui/utils";

import { suiUidBcs } from "../src/lib/bcs.ts";
import type { AftermathLpCoin } from "../src/presale/aftermath-lp.ts";
import {
  AFTERMATH_AMM_PACKAGE_ID,
  verifyAftermathLpCoin,
} from "../src/presale/aftermath-lp.ts";

// A fake chain holding one Aftermath `CreatePoolCapV2` as the mainnet
// publication 5FE2eVoacFwnLfixqRAGftH9UwWotxDt3BJUqkWHxWwQ laid it out: the
// capability owns two dynamic object fields, `TreasuryKey` to the LP coin's
// `TreasuryCap` and `MetadataKey` to its `CoinMetadata`.

export const AMM = normalizeSuiAddress(AFTERMATH_AMM_PACKAGE_ID);
export const OWNER = normalizeSuiAddress("0x0ca7");
export const TREASURY_ID = normalizeSuiObjectId("0x7e5");
export const METADATA_ID = normalizeSuiObjectId("0x3e7a");
const TREASURY_FIELD_ID = normalizeSuiObjectId("0xf7e5");
const METADATA_FIELD_ID = normalizeSuiObjectId("0xf3e7a");
const SUI = normalizeSuiAddress("0x2");

export const treasuryCapBcs = bcs.struct("TreasuryCap", {
  id: suiUidBcs,
  total_supply: bcs.struct("Supply", { value: bcs.u64() }),
});

export const coinMetadataBcs = bcs.struct("CoinMetadata", {
  id: suiUidBcs,
  decimals: bcs.u8(),
  name: bcs.string(),
  symbol: bcs.string(),
  description: bcs.string(),
  icon_url: bcs.option(bcs.struct("Url", { url: bcs.string() })),
});

export type FakeLpCoinChain = {
  createPoolCapId: string;
  lpType: string;
  owner?: string;
  /** The capability's type; defaults to the AMM's `CreatePoolCapV2`. */
  capType?: string;
  capOwner?: SuiClientTypes.ObjectOwner;
  treasurySupply?: bigint;
  /** The treasury child's type; defaults to `TreasuryCap<lpType>`. */
  treasuryType?: string;
  metadataDecimals?: number;
  metadataLpType?: string;
  /** Report the field names as `dynamic_object_field::Wrapper<key>`. */
  wrapKeys?: boolean;
  /** Replace the capability's field listing. */
  fields?: (
    defaults: SuiClientTypes.DynamicFieldEntry[],
  ) => SuiClientTypes.DynamicFieldEntry[];
  /** List one field per page. */
  paged?: boolean;
  transaction?: unknown;
};

export function fakeLpCoinClient(chain: FakeLpCoinChain) {
  const requests: { method: string; request: unknown }[] = [];
  const createPoolCapId = normalizeSuiObjectId(chain.createPoolCapId);
  const lpType = normalizeStructTag(chain.lpType);
  const owner = normalizeSuiAddress(chain.owner ?? OWNER);
  const key = (name: string) =>
    chain.wrapKeys
      ? `${SUI}::dynamic_object_field::Wrapper<${AMM}::pool::${name}>`
      : `${AMM}::pool::${name}`;
  const field = (
    fieldId: string,
    name: string,
    valueType: string,
    childId: string,
  ): SuiClientTypes.DynamicFieldEntry => ({
    fieldId,
    type: `${SUI}::dynamic_field::Field<${SUI}::dynamic_object_field::Wrapper<${AMM}::pool::${name}>,${SUI}::object::ID>`,
    name: { type: key(name), bcs: new Uint8Array() },
    valueType,
    $kind: "DynamicObject",
    childId,
  });
  const defaults = [
    field(
      METADATA_FIELD_ID,
      "MetadataKey",
      `${SUI}::coin::CoinMetadata<${lpType}>`,
      METADATA_ID,
    ),
    field(
      TREASURY_FIELD_ID,
      "TreasuryKey",
      `${SUI}::coin::TreasuryCap<${lpType}>`,
      TREASURY_ID,
    ),
  ];
  const fields = chain.fields ? chain.fields(defaults) : defaults;

  const objects: Record<string, object> = {
    [createPoolCapId]: {
      objectId: createPoolCapId,
      version: "9",
      digest: "cap",
      owner: chain.capOwner ?? { $kind: "AddressOwner", AddressOwner: owner },
      type: chain.capType ?? `${AMM}::pool::CreatePoolCapV2`,
    },
    [TREASURY_ID]: {
      objectId: TREASURY_ID,
      version: "9",
      digest: "treasury",
      owner: { $kind: "ObjectOwner", ObjectOwner: TREASURY_FIELD_ID },
      type: chain.treasuryType ?? `${SUI}::coin::TreasuryCap<${lpType}>`,
      content: treasuryCapBcs
        .serialize({
          id: { id: { bytes: TREASURY_ID } },
          total_supply: { value: chain.treasurySupply ?? 0n },
        })
        .toBytes(),
    },
    [METADATA_ID]: {
      objectId: METADATA_ID,
      version: "9",
      digest: "metadata",
      owner: { $kind: "ObjectOwner", ObjectOwner: METADATA_FIELD_ID },
      type: `${SUI}::coin::CoinMetadata<${normalizeStructTag(chain.metadataLpType ?? lpType)}>`,
      content: coinMetadataBcs
        .serialize({
          id: { id: { bytes: METADATA_ID } },
          decimals: chain.metadataDecimals ?? 9,
          name: "Meme / SUI LP",
          symbol: "MEMESUILP",
          description: "",
          icon_url: null,
        })
        .toBytes(),
    },
  };

  const client = {
    core: {
      getObject: async (request: { objectId: string }) => {
        requests.push({ method: "getObject", request });
        const object = objects[normalizeSuiObjectId(request.objectId)];
        if (!object) {
          throw new ObjectError("notFound", "missing", { reason: "notFound" });
        }
        return { object };
      },
      listDynamicFields: async (request: {
        parentId: string;
        cursor?: string | null;
      }) => {
        requests.push({ method: "listDynamicFields", request });
        if (normalizeSuiObjectId(request.parentId) !== createPoolCapId) {
          return { dynamicFields: [], hasNextPage: false, cursor: null };
        }
        if (!chain.paged) {
          return { dynamicFields: fields, hasNextPage: false, cursor: null };
        }
        const index = request.cursor ? Number(request.cursor) : 0;
        const entry = fields[index];
        return {
          dynamicFields: entry ? [entry] : [],
          hasNextPage: index + 1 < fields.length,
          cursor: String(index + 1),
        };
      },
      getTransaction: async (request: unknown) => {
        requests.push({ method: "getTransaction", request });
        return { $kind: "Transaction", Transaction: chain.transaction };
      },
    },
  } as unknown as ClientWithCoreApi;
  return { client, requests };
}

/** The `AftermathLpCoin` the fake chain's capability verifies to. */
export async function verifiedLpCoin(
  lpType: string,
  createPoolCapId: string,
  owner: string = OWNER,
): Promise<AftermathLpCoin> {
  const { client } = fakeLpCoinClient({ lpType, createPoolCapId, owner });
  return verifyAftermathLpCoin(client, { createPoolCapId, lpType, owner });
}
