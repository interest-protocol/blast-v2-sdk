import type {
  TransactionObjectArgument,
  TransactionObjectInput,
} from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
} from "@mysten/sui/utils";

import type { SharedObjectIdentity } from "../lib/sui.ts";
import { normalizeSharedObjectIdentity } from "../lib/sui.ts";

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

/**
 * `blast_admin::blast_acl` calls. A role is a Move type its consumer package
 * declares (for example `<launchpad>::blast_fun_domain::FeeAdmin`); each
 * product's `roleType` names its own.
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

function single(call: (tx: Transaction) => void): Transaction {
  const tx = new Transaction();
  tx.add(call);
  return tx;
}
