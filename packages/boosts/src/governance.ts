import type {
  Transaction,
  TransactionArgument,
  TransactionObjectArgument,
  TransactionObjectInput,
} from "@mysten/sui/transactions";
import { getBoostsProduct } from "./manifest.ts";
import type { BoostsManifest, BoostsProductKey } from "./types.ts";

type Witness = { adminWitness: TransactionObjectArgument };

export type BoostsGovernanceAction =
  | ({
      kind: "schedule_fees";
      mintFeeBps: bigint;
      redeemFeeBps: bigint;
      adminShareBps: bigint;
    } & Witness)
  | ({ kind: "schedule_nav_cap"; navCapAtoms: bigint } & Witness)
  | ({
      kind: "schedule_max_order_notional";
      maxOrderNotional: bigint;
    } & Witness)
  | ({
      kind: "cancel_fees" | "cancel_nav_cap" | "cancel_max_order_notional";
    } & Witness)
  | { kind: "apply_fees" | "apply_nav_cap" | "apply_max_order_notional" }
  | ({
      kind: "add_partner" | "remove_partner";
      partner: TransactionObjectInput;
    } & Witness)
  | ({
      kind: "withdraw_admin_fees";
      treasury: TransactionObjectInput;
      amountAtoms: bigint;
    } & Witness)
  | ({
      kind: "unpause";
      packageAdmin: TransactionObjectInput;
      treasury: TransactionObjectInput;
    } & Witness)
  | ({ kind: "activate_upgrade" } & Witness)
  | ({
      kind: "make_immutable";
      packageAdmin: TransactionObjectInput;
    } & Witness);

/** Append a governance call. Pass the typed witness returned by the shared ACL sign-in in this transaction. */
export function addBoostsGovernanceCall(
  tx: Transaction,
  manifest: BoostsManifest,
  productKey: BoostsProductKey,
  action: BoostsGovernanceAction,
): void {
  const product = getBoostsProduct(manifest, productKey);
  const adapter = manifest.adapterPackage.packageId;
  const protocol = tx.object(product.protocol);
  const clock = () => tx.object(product.clock);
  const version = () => tx.object(product.packageVersion);
  switch (action.kind) {
    case "activate_upgrade":
      tx.moveCall({
        target: `${adapter}::package_admin::activate_upgrade`,
        arguments: [protocol, action.adminWitness],
      });
      return;
    case "make_immutable":
      tx.moveCall({
        target: `${adapter}::package_admin::make_immutable`,
        arguments: [
          tx.object(action.packageAdmin),
          protocol,
          version(),
          action.adminWitness,
          clock(),
        ],
      });
      return;
    case "unpause":
      tx.moveCall({
        target: `${adapter}::package_admin::unpause`,
        arguments: [
          protocol,
          tx.object(action.packageAdmin),
          version(),
          tx.object(action.treasury),
          action.adminWitness,
        ],
      });
      return;
    case "add_partner":
    case "remove_partner":
      tx.moveCall({
        target: `${adapter}::operations::${action.kind}`,
        arguments: [
          protocol,
          action.adminWitness,
          tx.object(action.partner),
          ...(action.kind === "remove_partner" ? [clock()] : []),
        ],
      });
      return;
  }
  const typeArguments = [product.productType, product.collateralType];
  const args: TransactionArgument[] = [
    tx.sharedObjectRef(product.vault),
    protocol,
  ];
  if (action.kind === "apply_max_order_notional") {
    tx.moveCall({
      target: `${adapter}::operations::apply_max_order_notional`,
      typeArguments,
      arguments: [
        ...args,
        tx.object(product.venueAccount),
        tx.object(product.registry),
        tx.object(product.clearingHouse),
        tx.object(product.baseOracleStorage),
        tx.object(product.collateralOracleStorage),
        clock(),
      ],
    });
    return;
  }
  if ("adminWitness" in action) args.push(action.adminWitness);
  switch (action.kind) {
    case "schedule_fees":
      args.push(
        tx.pure.u64(action.mintFeeBps),
        tx.pure.u64(action.redeemFeeBps),
        tx.pure.u64(action.adminShareBps),
        clock(),
      );
      break;
    case "schedule_nav_cap":
      args.push(tx.pure.u64(action.navCapAtoms), clock());
      break;
    case "schedule_max_order_notional":
      args.push(tx.pure.u64(action.maxOrderNotional), clock());
      break;
    case "apply_fees":
    case "apply_nav_cap":
      args.push(clock());
      break;
    case "withdraw_admin_fees":
      args.push(tx.object(action.treasury), tx.pure.u64(action.amountAtoms));
      break;
  }
  tx.moveCall({
    target: `${adapter}::vault::${action.kind}`,
    typeArguments,
    arguments: args,
  });
}
