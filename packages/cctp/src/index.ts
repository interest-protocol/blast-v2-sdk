import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";
import invariant from "tiny-invariant";
import type { Address, Hex } from "viem";
import { getAddress, zeroAddress, zeroHash } from "viem";

import { cctpForwarderFactoryAbi } from "./abi.ts";

export * from "./abi.ts";

export const CCTP_MODE_STANDARD = 0;
export const CCTP_MODE_FAST = 1;
export type CctpMode = typeof CCTP_MODE_STANDARD | typeof CCTP_MODE_FAST;

/**
 * Parameters for viem's readContract (addressOf/initCode), simulateContract
 * or writeContract (deploy/forward). The caller supplies the deployed factory
 * on its selected chain. The recipient is a Sui address, never an EVM address.
 */
export function cctpDepositParameters({
  factory,
  recipient,
  mode = CCTP_MODE_FAST,
  index = 0,
}: {
  factory: Address;
  recipient: string;
  mode?: CctpMode;
  index?: number;
}) {
  const address = getAddress(factory);
  invariant(address !== zeroAddress, "CCTP factory must be nonzero");
  const normalizedRecipient = normalizeSuiAddress(recipient);
  invariant(
    isValidSuiAddress(normalizedRecipient) && normalizedRecipient !== zeroHash,
    "CCTP recipient must be a nonzero Sui address",
  );
  invariant(
    mode === CCTP_MODE_STANDARD || mode === CCTP_MODE_FAST,
    "CCTP mode must be Standard (0) or Fast (1)",
  );
  invariant(
    Number.isInteger(index) && index >= 0 && index <= 0xffff_ffff,
    "CCTP index must be a uint32",
  );
  return {
    address,
    abi: cctpForwarderFactoryAbi,
    args: [normalizedRecipient as Hex, mode, index] as const,
  };
}
