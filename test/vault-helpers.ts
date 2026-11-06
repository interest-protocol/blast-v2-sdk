import type {
  DecodedVaultDelayedEvent,
  DecodedVaultEvent,
} from "@interest-protocol/blast-vault-sdk/events";
import {
  decodeVaultDelayedEvent,
  decodeVaultEvent,
} from "@interest-protocol/blast-vault-sdk/events";
import type { VaultDeployment } from "@interest-protocol/blast-vault-sdk/transactions";
import type { SuiClientTypes } from "@mysten/sui/client";
import { fromHex, normalizeSuiAddress } from "@mysten/sui/utils";
import { VAULT_FIXTURE as fixture } from "./fixtures/vault-86ee8cf.ts";

export { fixture };

export const id = (value: string) => normalizeSuiAddress(value);

/** The fixture's vault at an upgraded package ID, with stand-in core and admin packages. */
export const deployment: VaultDeployment = {
  packageId: id("0xf4"),
  originalPackageId: fixture.vaultOriginalPackageId,
  registry: { objectId: fixture.registryId, initialSharedVersion: 3 },
  packageVersion: { objectId: id("0xa2"), initialSharedVersion: 3 },
  packageAdmin: { objectId: id("0xa3"), initialSharedVersion: 3 },
  core: {
    packageId: id("0xc0"),
    originalPackageId: id("0xc1"),
    treasury: { objectId: id("0xc2"), initialSharedVersion: 2 },
  },
  admin: {
    packageId: id("0xad"),
    acl: { objectId: id("0xac"), initialSharedVersion: 1 },
  },
};

export const vaultType = `${fixture.vaultOriginalPackageId}::vault::Vault<${fixture.memeType}, ${fixture.quoteType}>`;
export const roundType = `${fixture.vaultOriginalPackageId}::holder_rewards::Round<${fixture.memeType}, ${fixture.quoteType}>`;
export const registryType = `${fixture.vaultOriginalPackageId}::blast_vault_package::VaultRegistry`;

let eventIndex = 0;

/** A Core API event entry, one transaction per entry, in call order. */
export function eventEntry(
  eventType: string,
  hex: string,
): SuiClientTypes.EventEntry {
  eventIndex += 1;
  return {
    packageId: fixture.vaultOriginalPackageId,
    module: "vault",
    sender: id("0x5e4d"),
    eventType,
    bcs: fromHex(hex),
    json: null,
    checkpoint: "9",
    transactionDigest: `tx-${eventIndex}`,
    eventIndex: 0,
  } as SuiClientTypes.EventEntry;
}

/** A fixture `blast_vault_events` struct, typed as Move emitted it. */
export function vaultEvent<const Kind extends keyof typeof fixture.events>(
  kind: Kind,
  hex: string = fixture.events[kind],
): Extract<
  DecodedVaultEvent,
  { kind: Kind extends "FeesCollected2" ? "FeesCollected" : Kind }
> {
  const name = kind === "FeesCollected2" ? "FeesCollected" : kind;
  const venue = kind === "VaultCreated" ? `, ${fixture.venue}` : "";
  return decodeVaultEvent(
    eventEntry(
      `${fixture.vaultOriginalPackageId}::blast_vault_events::${name}<${fixture.memeType}, ${fixture.quoteType}${venue}>`,
      hex,
    ),
    deployment,
  ) as never;
}

const delayedTypes = {
  FeeSplitScheduled: `delayed::DelayedScheduled<${fixture.vaultOriginalPackageId}::vault::FeeSplitKey, ${deployment.core.originalPackageId}::fee_split::FeeSplit>`,
  ProtocolBpsScheduled: `delayed::DelayedScheduled<${fixture.vaultOriginalPackageId}::vault::ProtocolBpsKey, ${fixture.vaultOriginalPackageId}::vault::ProtocolBps>`,
  RoundScheduled: `delayed_action::ActionScheduled<${fixture.vaultOriginalPackageId}::vault::RoundPublicationKey, ${fixture.vaultOriginalPackageId}::vault::RoundTerms>`,
} as const;

/** A fixture `blast_admin` delayed event of the vault's keys. */
export function vaultDelayedEvent<
  const Kind extends keyof typeof fixture.delayedEvents,
>(
  kind: Kind,
): Extract<
  DecodedVaultDelayedEvent,
  {
    FeeSplitScheduled: { name: "FeeSplit"; kind: "DelayedScheduled" };
    ProtocolBpsScheduled: { name: "ProtocolBps"; kind: "DelayedScheduled" };
    RoundScheduled: { name: "RoundPublication"; kind: "ActionScheduled" };
  }[Kind]
> {
  return decodeVaultDelayedEvent(
    eventEntry(
      `${deployment.admin.packageId}::${delayedTypes[kind]}`,
      fixture.delayedEvents[kind],
    ),
    deployment,
  ) as never;
}

/** Move `type_name` text of a normalized type: every `0x` address prefix dropped. */
export function moveTypeName(type: string): string {
  return type.replace(/0x([0-9a-f]{64})/g, "$1");
}
