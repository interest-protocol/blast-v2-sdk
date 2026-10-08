import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress, SUI_FRAMEWORK_ADDRESS } from "@mysten/sui/utils";

import type { CoinTemplateOptions } from "./template.ts";
import {
  buildCoinPackageBytecode,
  COIN_PACKAGE_DEPENDENCIES,
} from "./template.ts";

export type CoinPublication = CoinTemplateOptions & {
  /**
   * Receives the package's `UpgradeCap`; null makes the package immutable in
   * the same transaction, so nobody can ever change the coin's module.
   */
  upgradeCapRecipient: string | null;
};

/**
 * Publishes a standalone coin from the coin template (contracts ADR 0108).
 * The initializer runs at publication and delivers the supply and the
 * capabilities to the recipients `options` names; its `Currency` goes to the
 * Coin Registry address, where anyone may share it with
 * `coin_registry::finalize_registration` in a later transaction.
 */
export function publishCoin(options: CoinPublication): Transaction {
  const tx = new Transaction();
  const upgradeCap = tx.add(async (innerTx) => {
    const module = await buildCoinPackageBytecode(options);
    return innerTx.publish({
      modules: [Array.from(module)],
      dependencies: [...COIN_PACKAGE_DEPENDENCIES],
    });
  });
  if (options.upgradeCapRecipient === null) {
    tx.moveCall({
      target: `${SUI_FRAMEWORK_ADDRESS}::package::make_immutable`,
      arguments: [upgradeCap],
    });
  } else {
    tx.transferObjects(
      [upgradeCap],
      normalizeSuiAddress(options.upgradeCapRecipient),
    );
  }
  return tx;
}
