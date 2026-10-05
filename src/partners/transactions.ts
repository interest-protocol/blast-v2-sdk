import type {
  TransactionObjectArgument,
  TransactionObjectInput,
  TransactionResult,
} from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress, normalizeSuiObjectId } from "@mysten/sui/utils";

import type { AdminDeployment } from "../admin/transactions.ts";
import { AdminCalls, normalizeAdminDeployment } from "../admin/transactions.ts";
import { requireBasisPoints } from "../lib/integers.ts";
import type { SharedObjectReference } from "../lib/sui.ts";
import { normalizeSharedObjectReference } from "../lib/sui.ts";

/** The immutable `blast_partners` package and the ACL its `PartnerAdmin` signs in to. */
export type PartnersDeployment = {
  packageId: string;
  admin: AdminDeployment;
};

/** `blast_partners::blast_partners` calls. */
export class PartnersCalls {
  readonly deployment: PartnersDeployment;
  readonly admin: AdminCalls;

  constructor(deployment: PartnersDeployment) {
    this.deployment = {
      packageId: normalizeSuiObjectId(deployment.packageId),
      admin: normalizeAdminDeployment(deployment.admin),
    };
    this.admin = new AdminCalls(this.deployment.admin);
  }

  /** The `PartnerAdmin` role type, for `AdminCalls.grantRole`. */
  roleType(): string {
    return `${this.deployment.packageId}::blast_partners::PartnerAdmin`;
  }

  /** This PTB's `AdminWitness<PartnerAdmin>`. */
  signIn(options: { adminCap: TransactionObjectInput }) {
    return this.admin.signIn({
      adminCap: options.adminCap,
      role: this.roleType(),
    });
  }

  /** `new_cap`: anyone may mint one; it controls nothing until a partner names it. */
  newCap() {
    return (tx: Transaction): TransactionResult =>
      tx.moveCall({ target: this.#target("new_cap") });
  }

  /**
   * `register` (`PartnerAdmin`): shares a partner managed by the cap
   * `capId`, its share and cap in force at once.
   */
  register(options: {
    adminWitness: TransactionObjectInput;
    capId: string;
    recipient: string;
    shareBps: bigint;
  }) {
    const capId = normalizeSuiObjectId(options.capId);
    const recipient = normalizeSuiAddress(options.recipient);
    const shareBps = requireBasisPoints("shareBps", options.shareBps);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: this.#target("register"),
        arguments: [
          tx.object(options.adminWitness),
          tx.pure.id(capId),
          tx.pure.address(recipient),
          tx.pure.u64(shareBps),
        ],
      });
    };
  }

  /** `schedule_share` (`PartnerAdmin`): the share takes effect after the partner delay. */
  scheduleShare(options: {
    partner: SharedObjectReference<true>;
    adminWitness: TransactionObjectInput;
    shareBps: bigint;
  }) {
    const shareBps = requireBasisPoints("shareBps", options.shareBps);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: this.#target("schedule_share"),
        arguments: [
          partner(tx, options.partner),
          tx.object(options.adminWitness),
          tx.pure.u64(shareBps),
          tx.object.clock(),
        ],
      });
    };
  }

  /** `schedule_cap` (`PartnerAdmin`): moves the partner to the cap `capId` after the delay. */
  scheduleCap(options: {
    partner: SharedObjectReference<true>;
    adminWitness: TransactionObjectInput;
    capId: string;
  }) {
    const capId = normalizeSuiObjectId(options.capId);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: this.#target("schedule_cap"),
        arguments: [
          partner(tx, options.partner),
          tx.object(options.adminWitness),
          tx.pure.id(capId),
          tx.object.clock(),
        ],
      });
    };
  }

  /** `set_recipient`: the partner's live cap sets where it is paid, at once. */
  setRecipient(options: {
    partner: SharedObjectReference<true>;
    partnerCap: TransactionObjectInput;
    recipient: string;
  }) {
    const recipient = normalizeSuiAddress(options.recipient);
    return (tx: Transaction): void => {
      tx.moveCall({
        target: this.#target("set_recipient"),
        arguments: [
          partner(tx, options.partner),
          tx.object(options.partnerCap),
          tx.pure.address(recipient),
          tx.object.clock(),
        ],
      });
    };
  }

  destroyCap(options: { partnerCap: TransactionObjectInput }) {
    return (tx: Transaction): void => {
      tx.moveCall({
        target: this.#target("destroy_cap"),
        arguments: [tx.object(options.partnerCap)],
      });
    };
  }

  #target(functionName: string): string {
    return `${this.deployment.packageId}::blast_partners::${functionName}`;
  }
}

export class PartnersTransactions {
  readonly call: PartnersCalls;

  constructor(deployment: PartnersDeployment) {
    this.call = new PartnersCalls(deployment);
  }

  /** Mints a `PartnerCap` and sends it to `recipient`. */
  newCap(options: { recipient: string }): Transaction {
    const tx = new Transaction();
    const cap = tx.add(this.call.newCap());
    tx.transferObjects([cap], normalizeSuiAddress(options.recipient));
    return tx;
  }

  register(options: {
    adminCapId: string;
    capId: string;
    recipient: string;
    shareBps: bigint;
  }): Transaction {
    return this.#asPartnerAdmin(options.adminCapId, (adminWitness) =>
      this.call.register({ ...options, adminWitness }),
    );
  }

  scheduleShare(options: {
    adminCapId: string;
    partner: SharedObjectReference<true>;
    shareBps: bigint;
  }): Transaction {
    return this.#asPartnerAdmin(options.adminCapId, (adminWitness) =>
      this.call.scheduleShare({ ...options, adminWitness }),
    );
  }

  scheduleCap(options: {
    adminCapId: string;
    partner: SharedObjectReference<true>;
    capId: string;
  }): Transaction {
    return this.#asPartnerAdmin(options.adminCapId, (adminWitness) =>
      this.call.scheduleCap({ ...options, adminWitness }),
    );
  }

  setRecipient(options: {
    partner: SharedObjectReference<true>;
    partnerCapId: string;
    recipient: string;
  }): Transaction {
    const tx = new Transaction();
    tx.add(
      this.call.setRecipient({ ...options, partnerCap: options.partnerCapId }),
    );
    return tx;
  }

  destroyCap(options: { partnerCapId: string }): Transaction {
    const tx = new Transaction();
    tx.add(this.call.destroyCap({ partnerCap: options.partnerCapId }));
    return tx;
  }

  #asPartnerAdmin(
    adminCapId: string,
    call: (
      adminWitness: TransactionObjectArgument,
    ) => (tx: Transaction) => void,
  ): Transaction {
    const tx = new Transaction();
    const adminWitness = tx.add(this.call.signIn({ adminCap: adminCapId }));
    tx.add(call(adminWitness));
    return tx;
  }
}

function partner(
  tx: Transaction,
  reference: SharedObjectReference<true>,
): TransactionObjectArgument {
  return tx.sharedObjectRef(
    normalizeSharedObjectReference("partner", reference, true),
  );
}
