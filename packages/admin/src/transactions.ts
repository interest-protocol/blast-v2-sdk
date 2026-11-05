import { requireU64 } from "@interest-protocol/blast-core/integers";
import type { SharedObjectIdentity } from "@interest-protocol/blast-core/sui";
import { normalizeSharedObjectIdentity } from "@interest-protocol/blast-core/sui";
import type {
  TransactionArgument,
  TransactionObjectArgument,
  TransactionObjectInput,
} from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
} from "@mysten/sui/utils";

/** The immutable `blast_admin` package and its shared singleton `blast_acl::ACL`. */
export type AdminDeployment = {
  packageId: string;
  acl: SharedObjectIdentity;
};

export function normalizeAdminDeployment(
  deployment: AdminDeployment,
): AdminDeployment {
  return {
    packageId: normalizeSuiObjectId(deployment.packageId),
    acl: normalizeSharedObjectIdentity("admin.acl", deployment.acl),
  };
}

/** `blast_admin::package_admin`'s roles, each generic over one package's OTW. */
export const PACKAGE_ROLES = [
  "UpgradeAdmin",
  "PauseAdmin",
  "UnpauseAdmin",
  "CancelAdmin",
] as const;
export type PackageRole = (typeof PACKAGE_ROLES)[number];

/** `<admin>::package_admin::<role><otw>`: one package's infrastructure role. */
export function packageRoleType(
  admin: Pick<AdminDeployment, "packageId">,
  otw: string,
  role: PackageRole,
): string {
  if (!PACKAGE_ROLES.includes(role))
    throw new TypeError(`unknown package_admin role ${String(role)}`);
  return normalizeStructTag(
    `${normalizeSuiObjectId(admin.packageId)}::package_admin::${role}<${normalizeStructTag(otw)}>`,
  );
}

/** One package's shared `PackageVersion<OTW>` or `PackageAdmin<OTW>` and its OTW type. */
type PackageObjectOptions<Name extends "packageVersion" | "packageAdmin"> = {
  otw: string;
} & Record<Name, SharedObjectIdentity>;

/**
 * `blast_admin::blast_acl` and `blast_admin::package_admin` calls. A product
 * role is a `blast_core::blast_domain` type (`coreRoleType`); a package role
 * is `package_admin::<Role><OTW>` (`packageRoleType`). A product's own
 * `unpause` and `make_immutable` wrappers live with the product.
 */
export class AdminCalls {
  readonly deployment: AdminDeployment;

  constructor(deployment: AdminDeployment) {
    this.deployment = normalizeAdminDeployment(deployment);
  }

  /** `sign_in<Role>`: this PTB's `AdminWitness<Role>`; the `AdminCap` must hold `role`. */
  signIn(options: { adminCap: TransactionObjectInput; role: string }) {
    const role = normalizeStructTag(options.role);
    return (tx: Transaction): TransactionObjectArgument =>
      tx.moveCall({
        target: this.#target("sign_in"),
        typeArguments: [role],
        arguments: [this.#acl(tx, false), tx.object(options.adminCap)],
      });
  }

  /** `grant_admin`: delivers a new `AdminCap` with no role to `recipient`. */
  grantAdmin(options: {
    superAdminCap: TransactionObjectInput;
    recipient: string;
  }) {
    const recipient = normalizeSuiAddress(options.recipient);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: this.#target("grant_admin"),
        arguments: [
          this.#acl(tx, true),
          tx.object(options.superAdminCap),
          tx.pure.address(recipient),
        ],
      });
    };
  }

  /** `revoke_admin`: retires a live `AdminCap` and every role it holds. */
  revokeAdmin(options: {
    superAdminCap: TransactionObjectInput;
    adminCapId: string;
  }) {
    const adminCapId = normalizeSuiObjectId(options.adminCapId);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: this.#target("revoke_admin"),
        arguments: [
          this.#acl(tx, true),
          tx.object(options.superAdminCap),
          tx.pure.id(adminCapId),
        ],
      });
    };
  }

  /** `grant_role<Role>` to a live administrator. */
  grantRole(options: {
    superAdminCap: TransactionObjectInput;
    adminCapId: string;
    role: string;
  }) {
    return this.#roleCall("grant_role", options);
  }

  /** `revoke_role<Role>` from a live administrator. */
  revokeRole(options: {
    superAdminCap: TransactionObjectInput;
    adminCapId: string;
    role: string;
  }) {
    return this.#roleCall("revoke_role", options);
  }

  /** `destroy_admin_cap`: deletes the holder's own live or revoked cap. */
  destroyAdminCap(options: { adminCap: TransactionObjectInput }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: this.#target("destroy_admin_cap"),
        arguments: [this.#acl(tx, true), tx.object(options.adminCap)],
      });
    };
  }

  /**
   * `begin_super_admin_transfer`: nominates `recipient`, who may accept once
   * the ACL's seven-day delay passes; it replaces a pending nomination.
   */
  beginSuperAdminTransfer(options: {
    superAdminCap: TransactionObjectInput;
    recipient: string;
  }) {
    const recipient = normalizeSuiAddress(options.recipient);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: this.#target("begin_super_admin_transfer"),
        arguments: [
          this.#acl(tx, true),
          tx.object(options.superAdminCap),
          tx.pure.address(recipient),
          tx.object.clock(),
        ],
      });
    };
  }

  cancelSuperAdminTransfer(options: { superAdminCap: TransactionObjectInput }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: this.#target("cancel_super_admin_transfer"),
        arguments: [this.#acl(tx, true), tx.object(options.superAdminCap)],
      });
    };
  }

  /** `accept_super_admin_transfer`: the sender must be the ready nominee. */
  acceptSuperAdminTransfer() {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: this.#target("accept_super_admin_transfer"),
        arguments: [this.#acl(tx, true), tx.object.clock()],
      });
    };
  }

  /** `destroy_retired_super_admin_cap`: deletes a root an accepted transfer replaced. */
  destroyRetiredSuperAdminCap(options: {
    superAdminCap: TransactionObjectInput;
  }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: this.#target("destroy_retired_super_admin_cap"),
        arguments: [this.#acl(tx, false), tx.object(options.superAdminCap)],
      });
    };
  }

  /** `package_admin::pause<OTW>` with a `PauseAdmin<OTW>` witness: sets `bits` now. */
  pause(
    options: PackageObjectOptions<"packageVersion"> & {
      adminWitness: TransactionObjectInput;
      bits: number;
    },
  ) {
    const bits = requirePauseBits(options.bits);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: this.#packageAdminTarget("pause"),
        typeArguments: [normalizeStructTag(options.otw)],
        arguments: [
          tx.sharedObjectRef({ ...options.packageVersion, mutable: true }),
          tx.object(options.adminWitness),
          tx.pure.u8(bits),
        ],
      });
    };
  }

  /** `package_admin::schedule_upgrade<OTW>` of one 32-byte package digest. */
  scheduleUpgrade(
    options: PackageObjectOptions<"packageAdmin"> & {
      adminWitness: TransactionObjectInput;
      digest: Uint8Array;
    },
  ) {
    if (options.digest.length !== 32)
      throw new RangeError("a package digest is 32 bytes");
    const digest = Array.from(options.digest);
    return this.#upgradeCall(options, "schedule_upgrade", (tx) => [
      tx.object(options.adminWitness),
      tx.pure.vector("u8", digest),
      tx.object.clock(),
    ]);
  }

  /** `package_admin::schedule_make_immutable<OTW>`. */
  scheduleMakeImmutable(
    options: PackageObjectOptions<"packageAdmin"> & {
      adminWitness: TransactionObjectInput;
    },
  ) {
    return this.#upgradeCall(options, "schedule_make_immutable", (tx) => [
      tx.object(options.adminWitness),
      tx.object.clock(),
    ]);
  }

  /** `package_admin::cancel_upgrade_action<OTW>` with a `CancelAdmin<OTW>` witness. */
  cancelUpgradeAction(
    options: PackageObjectOptions<"packageAdmin"> & {
      adminWitness: TransactionObjectInput;
    },
  ) {
    return this.#upgradeCall(options, "cancel_upgrade_action", (tx) => [
      tx.object(options.adminWitness),
    ]);
  }

  /** `package_admin::schedule_upgrade_delay<OTW>`: proposes only a new delay. */
  scheduleUpgradeDelay(
    options: PackageObjectOptions<"packageAdmin"> & {
      adminWitness: TransactionObjectInput;
      delayMs: bigint;
    },
  ) {
    const delayMs = requireU64("delayMs", options.delayMs);
    return this.#upgradeCall(options, "schedule_upgrade_delay", (tx) => [
      tx.object(options.adminWitness),
      tx.pure.u64(delayMs),
      tx.object.clock(),
    ]);
  }

  /** `package_admin::apply_upgrade_delay<OTW>`: anyone, once ready. */
  applyUpgradeDelay(options: PackageObjectOptions<"packageAdmin">) {
    return this.#upgradeCall(options, "apply_upgrade_delay", (tx) => [
      tx.object.clock(),
    ]);
  }

  #upgradeCall(
    options: PackageObjectOptions<"packageAdmin">,
    functionName: string,
    rest: (tx: Transaction) => TransactionArgument[],
  ) {
    const otw = normalizeStructTag(options.otw);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: this.#packageAdminTarget(functionName),
        typeArguments: [otw],
        arguments: [
          tx.sharedObjectRef({ ...options.packageAdmin, mutable: true }),
          ...rest(tx),
        ],
      });
    };
  }

  #packageAdminTarget(functionName: string): string {
    return `${this.deployment.packageId}::package_admin::${functionName}`;
  }

  #roleCall(
    functionName: "grant_role" | "revoke_role",
    options: {
      superAdminCap: TransactionObjectInput;
      adminCapId: string;
      role: string;
    },
  ) {
    const role = normalizeStructTag(options.role);
    const adminCapId = normalizeSuiObjectId(options.adminCapId);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: this.#target(functionName),
        typeArguments: [role],
        arguments: [
          this.#acl(tx, true),
          tx.object(options.superAdminCap),
          tx.pure.id(adminCapId),
        ],
      });
    };
  }

  #target(functionName: string): string {
    return `${this.deployment.packageId}::blast_acl::${functionName}`;
  }

  #acl(tx: Transaction, mutable: boolean): TransactionObjectArgument {
    return tx.sharedObjectRef({ ...this.deployment.acl, mutable });
  }
}

/** One-call PTBs for the ACL's root and administrators. */
export class AdminTransactions {
  readonly call: AdminCalls;

  constructor(deployment: AdminDeployment) {
    this.call = new AdminCalls(deployment);
  }

  grantAdmin(options: { superAdminCapId: string; recipient: string }) {
    return single(
      this.call.grantAdmin({
        superAdminCap: options.superAdminCapId,
        recipient: options.recipient,
      }),
    );
  }

  revokeAdmin(options: { superAdminCapId: string; adminCapId: string }) {
    return single(
      this.call.revokeAdmin({
        superAdminCap: options.superAdminCapId,
        adminCapId: options.adminCapId,
      }),
    );
  }

  grantRole(options: {
    superAdminCapId: string;
    adminCapId: string;
    role: string;
  }) {
    return single(
      this.call.grantRole({
        ...options,
        superAdminCap: options.superAdminCapId,
      }),
    );
  }

  revokeRole(options: {
    superAdminCapId: string;
    adminCapId: string;
    role: string;
  }) {
    return single(
      this.call.revokeRole({
        ...options,
        superAdminCap: options.superAdminCapId,
      }),
    );
  }

  destroyAdminCap(options: { adminCapId: string }) {
    return single(this.call.destroyAdminCap({ adminCap: options.adminCapId }));
  }

  beginSuperAdminTransfer(options: {
    superAdminCapId: string;
    recipient: string;
  }) {
    return single(
      this.call.beginSuperAdminTransfer({
        superAdminCap: options.superAdminCapId,
        recipient: options.recipient,
      }),
    );
  }

  cancelSuperAdminTransfer(options: { superAdminCapId: string }) {
    return single(
      this.call.cancelSuperAdminTransfer({
        superAdminCap: options.superAdminCapId,
      }),
    );
  }

  acceptSuperAdminTransfer() {
    return single(this.call.acceptSuperAdminTransfer());
  }

  destroyRetiredSuperAdminCap(options: { superAdminCapId: string }) {
    return single(
      this.call.destroyRetiredSuperAdminCap({
        superAdminCap: options.superAdminCapId,
      }),
    );
  }
}

/** Pause bits are a nonzero `u8` mask; the package checks they are its own. */
function requirePauseBits(bits: number): number {
  if (!Number.isInteger(bits) || bits <= 0 || bits > 0xff)
    throw new RangeError("pause bits must be a nonzero u8 mask");
  return bits;
}

function single(call: (tx: Transaction) => void): Transaction {
  const tx = new Transaction();
  tx.add(call);
  return tx;
}
