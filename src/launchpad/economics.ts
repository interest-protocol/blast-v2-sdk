import { mulDivUp, requirePositiveU64 } from "../lib/integers.ts";
import type { AllocationPlan } from "./allocation.ts";
import {
  apportionMeme,
  apportionQuote,
  requireCompletePlan,
} from "./allocation.ts";

export type LaunchEconomicsInput = {
  /** One billion whole tokens at the Meme's decimals. */
  atomicSupply: bigint;
  /**
   * The complete plan, Blast's shares set: a launch's `allocationPlan`, or a
   * creator plan passed through `addProtocolAllocation`.
   */
  allocationPlan: AllocationPlan;
  virtualQuote: bigint;
  graduationTarget: bigint;
};

export type LaunchEconomics = {
  /** The curve reserve at finalization. */
  curveMeme: bigint;
  /** Meme handed to the adapter for the pool at migration. */
  liquidityMeme: bigint;
  /** Quote handed to the adapter for the pool at the graduation target. */
  liquidityQuote: bigint;
  /** Terminal Quote paid to the plan's recipients or accrued as Blast's fee. */
  allocatedQuote: bigint;
  /** Blast's one-time migration fee at the graduation target, rounded up. */
  protocolMeme: bigint;
  protocolQuote: bigint;
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
  const plan = requireCompletePlan(input.allocationPlan);
  const {
    curve: curveMeme,
    lp: liquidityMeme,
    protocol: protocolMeme,
  } = apportionMeme(plan, atomicSupply);
  const { lp: liquidityQuote, protocol: protocolQuote } = apportionQuote(
    plan,
    graduationTarget,
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
    protocolMeme,
    protocolQuote,
    terminalCurveMeme,
    curveMemeReleased: curveMeme - terminalCurveMeme,
    openingValuation: (atomicSupply * virtualQuote) / curveMeme,
    curveTerminalValuation:
      (atomicSupply * effectiveTerminalQuote) / terminalCurveMeme,
    dexOpeningValuation: (atomicSupply * liquidityQuote) / liquidityMeme,
  };
}
