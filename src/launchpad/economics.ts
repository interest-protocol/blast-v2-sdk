import { mulDivUp, requirePositiveU64 } from "../lib/integers.ts";
import type { AllocationPlan } from "./allocation.ts";
import {
  allocationAmountFor,
  apportionMeme,
  apportionQuote,
  liquidityChannelId,
  normalizeAllocationPlan,
} from "./allocation.ts";

export type LaunchEconomicsInput = {
  /** One billion whole tokens at the Meme's decimals. */
  atomicSupply: bigint;
  allocationPlan: AllocationPlan;
  virtualQuote: bigint;
  graduationTarget: bigint;
};

export type LaunchEconomics = {
  /** Meme table entry for channel zero: the curve reserve at finalization. */
  curveMeme: bigint;
  /** Meme the Liquidity channel hands to the adapter at migration. */
  liquidityMeme: bigint;
  /** Quote the Liquidity channel hands to the adapter at the graduation target. */
  liquidityQuote: bigint;
  /** Terminal Quote paid to every non-liquidity channel. */
  allocatedQuote: bigint;
  terminalCurveMeme: bigint;
  curveMemeReleased: bigint;
  openingValuation: bigint;
  curveTerminalValuation: bigint;
  dexOpeningValuation: bigint;
};

/**
 * Derives launch economics in Meme and Quote atomic units.
 *
 * Plan amounts mirror `allocation::apportion_meme` and `apportion_quote` at the
 * atomic supply and at the graduation target, which is exactly the real Quote
 * reserve when trading closes. Terminal curve Meme rounds up; implied
 * total-supply valuations round down. For a Meme/SUI launch, valuations are MIST.
 */
export function deriveLaunchEconomics(
  input: LaunchEconomicsInput,
): LaunchEconomics {
  const atomicSupply = requirePositiveU64("atomicSupply", input.atomicSupply);
  const virtualQuote = requirePositiveU64("virtualQuote", input.virtualQuote);
  const graduationTarget = requirePositiveU64(
    "graduationTarget",
    input.graduationTarget,
  );
  const plan = normalizeAllocationPlan(input.allocationPlan);
  const liquidity = liquidityChannelId(plan);
  const memeAmounts = apportionMeme(plan, atomicSupply);
  const quoteAmounts = apportionQuote(plan, graduationTarget);
  const curveMeme = allocationAmountFor(plan.meme, memeAmounts, 0n);
  const liquidityMeme = allocationAmountFor(plan.meme, memeAmounts, liquidity);
  const liquidityQuote = allocationAmountFor(
    plan.quote,
    quoteAmounts,
    liquidity,
  );
  requirePositiveU64("curveMeme", curveMeme);
  requirePositiveU64("liquidityMeme", liquidityMeme);
  requirePositiveU64("liquidityQuote", liquidityQuote);

  const effectiveTerminalQuote = virtualQuote + graduationTarget;
  const terminalCurveMeme = mulDivUp(
    curveMeme,
    virtualQuote,
    effectiveTerminalQuote,
  );

  return {
    curveMeme,
    liquidityMeme,
    liquidityQuote,
    allocatedQuote: graduationTarget - liquidityQuote,
    terminalCurveMeme,
    curveMemeReleased: curveMeme - terminalCurveMeme,
    openingValuation: (atomicSupply * virtualQuote) / curveMeme,
    curveTerminalValuation:
      (atomicSupply * effectiveTerminalQuote) / terminalCurveMeme,
    dexOpeningValuation: (atomicSupply * liquidityQuote) / liquidityMeme,
  };
}
