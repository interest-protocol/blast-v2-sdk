import type { PackageRole } from "@interest-protocol/blast-admin-sdk/transactions";
import {
  AdminCalls,
  packageRoleType,
} from "@interest-protocol/blast-admin-sdk/transactions";
import type { CoreRole } from "@interest-protocol/blast-core/roles";
import { coreRoleType } from "@interest-protocol/blast-core/roles";
import {
  LAUNCHPAD_PAUSE_BITS,
  LaunchpadCalls,
  LaunchpadTransactions,
} from "@interest-protocol/blast-launchpad-sdk/transactions";
import {
  MIGRATOR_VENUES,
  venueWitnessType,
} from "@interest-protocol/blast-migrators-sdk/transactions";
import {
  PRESALE_PAUSE_BITS,
  PresaleCalls,
  PresaleTransactions,
} from "@interest-protocol/blast-presale-sdk/transactions";
import {
  VAULT_PAUSE_BITS,
  VaultCalls,
} from "@interest-protocol/blast-vault-sdk/transactions";
import type { TransactionObjectArgument } from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag } from "@mysten/sui/utils";
import {
  launchpadDeployment,
  migratorsDeployment,
  presaleDeployment,
  vaultDeployment,
} from "./registry.ts";
import type { BlastDeployment } from "./types.ts";

type Settings<Configure extends (options: never) => unknown> = Omit<
  Parameters<Configure>[0],
  "adminCapId"
>;

/** What the admission runbook configures beyond the manifest's own identities. */
export type AdmissionOptions = Readonly<{
  /** The launchpad's zero-notice settings (fees, quotes, decimals, partners, claim signer, allocation). */
  launchpad: Settings<LaunchpadTransactions["configureNow"]>;
  /** The launchpad's raised notices. */
  launchpadNotices: Settings<LaunchpadTransactions["armNotices"]>;
  /** The presale's zero-notice settings (fees, quotes, partners). */
  presale: Settings<PresaleTransactions["configureNow"]>;
  /** The presale's raised notices. */
  presaleNotices: Settings<PresaleTransactions["armNotices"]>;
  /** The vault registry's raised witness notice; 48 hours for this rollout. */
  witnessDelayMs: bigint;
}>;

/**
 * The paused admission of a freshly published stack (contracts
 * `deployments/README.md`, "Admission while paused"), as the ordered PTBs the
 * administrator signs with `adminCapId`. Admissions ignore the pause and
 * every publication-owned notice starts at zero, so:
 *
 * 1. the vault registry admits, at notice zero, both products' package
 *    witnesses and both migrators venues (`schedule_witness` then
 *    `apply_witness`); the vendor creates no vault and is never listed;
 * 2. each product admits its venues at notice zero (the launchpad the two
 *    migrators venues; the presale those and the vendor's `Venue` when the
 *    manifest records it), then applies its settings (`configureNow`);
 * 3. every notice is raised once each zero-notice proposal is applied: the
 *    vault's witness notice, then each product's (`armNotices`);
 * 4. the vault unpauses, then each product, each with its package's
 *    `UnpauseAdmin<OTW>`.
 *
 * The runbook is data-driven by the manifest; a step already done on chain
 * aborts when dry-run, which is the intended check. The cap needs
 * `VenueAdmin`, every role the settings name, and the three `UnpauseAdmin`
 * roles.
 */
export function admissionRunbook(
  deployment: BlastDeployment,
  adminCapId: string,
  options: AdmissionOptions,
): Transaction[] {
  const vault = new VaultCalls(vaultDeployment(deployment));
  const launchpad = launchpadDeployment(deployment);
  const presale = presaleDeployment(deployment);
  const launchpadCalls = new LaunchpadCalls(launchpad);
  const presaleCalls = new PresaleCalls(presale);
  const admin = new AdminCalls(vault.deployment.admin);
  const core = vault.deployment.core;
  const signIn = (tx: Transaction, role: string): TransactionObjectArgument =>
    tx.add(admin.signIn({ adminCap: adminCapId, role }));
  const asCore = (tx: Transaction, role: CoreRole) =>
    signIn(tx, coreRoleType(core, role));
  const asPackage = (tx: Transaction, otw: string, role: PackageRole) =>
    signIn(tx, packageRoleType(vault.deployment.admin, otw, role));

  const migrators = migratorsDeployment(deployment);
  const venues = MIGRATOR_VENUES.map((venue) =>
    venueWitnessType(migrators, venue),
  );
  const vendor = presale.aftermathDaoPresale;
  const presaleVenues = vendor
    ? [
        ...venues,
        normalizeStructTag(
          `${vendor.originalPackageId}::blast_aftermath_dao_presale::Venue`,
        ),
      ]
    : venues;

  const witnesses = new Transaction();
  const witnessAdmin = asCore(witnesses, "VenueAdmin");
  for (const witnessType of [
    witnessTypeOf(launchpad.originalPackageId, "blast_fun"),
    witnessTypeOf(presale.originalPackageId, "blast_presale_package"),
    ...venues,
  ]) {
    witnesses.add(
      vault.scheduleWitness({ witnessType, adminWitness: witnessAdmin }),
    );
    witnesses.add(vault.applyWitness({ witnessType }));
  }

  const productVenues = new Transaction();
  const venueAdmin = asCore(productVenues, "VenueAdmin");
  for (const [calls, types] of [
    [launchpadCalls, venues],
    [presaleCalls, presaleVenues],
  ] as const) {
    for (const venueType of types) {
      productVenues.add(
        calls.scheduleVenue({ venueType, adminWitness: venueAdmin }),
      );
      productVenues.add(calls.applyVenue({ venueType }));
    }
  }

  const launchpadTransactions = new LaunchpadTransactions(launchpad);
  const presaleTransactions = new PresaleTransactions(presale);

  const witnessNotice = new Transaction();
  witnessNotice.add(
    vault.scheduleWitnessDelay({
      adminWitness: asCore(witnessNotice, "VenueAdmin"),
      delayMs: options.witnessDelayMs,
    }),
  );
  witnessNotice.add(vault.applyWitnessDelay());

  const unpauseVault = new Transaction();
  unpauseVault.add(
    vault.unpause({
      unpauseAdmin: asPackage(unpauseVault, vault.otw, "UnpauseAdmin"),
      bits: VAULT_PAUSE_BITS.Admin,
    }),
  );
  const unpauseProduct = (
    calls: LaunchpadCalls | PresaleCalls,
    otw: string,
    bits: number,
  ) => {
    const tx = new Transaction();
    tx.add(
      calls.unpause({
        unpauseAdmin: asPackage(tx, otw, "UnpauseAdmin"),
        bits,
      }),
    );
    return tx;
  };

  return [
    witnesses,
    productVenues,
    launchpadTransactions.configureNow({ adminCapId, ...options.launchpad }),
    presaleTransactions.configureNow({ adminCapId, ...options.presale }),
    witnessNotice,
    launchpadTransactions.armNotices({
      adminCapId,
      ...options.launchpadNotices,
    }),
    presaleTransactions.armNotices({ adminCapId, ...options.presaleNotices }),
    unpauseVault,
    unpauseProduct(
      launchpadCalls,
      otwOf(launchpad.originalPackageId, "blast_fun", "BLAST_FUN"),
      allBits(LAUNCHPAD_PAUSE_BITS),
    ),
    unpauseProduct(
      presaleCalls,
      otwOf(
        presale.originalPackageId,
        "blast_presale_package",
        "BLAST_PRESALE_PACKAGE",
      ),
      allBits(PRESALE_PAUSE_BITS),
    ),
  ];
}

/** A product's `<original>::<module>::PackageWitness`, the vault issuer it seals under. */
function witnessTypeOf(originalPackageId: string, module: string): string {
  return otwOf(originalPackageId, module, "PackageWitness");
}

function otwOf(originalPackageId: string, module: string, name: string) {
  return normalizeStructTag(`${originalPackageId}::${module}::${name}`);
}

/** Every bit a package defines: its fully paused mask. */
function allBits(bits: Readonly<Record<string, number>>): number {
  return Object.values(bits).reduce((mask, bit) => mask | bit, 0);
}
