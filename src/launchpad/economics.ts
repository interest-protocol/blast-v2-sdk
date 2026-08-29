import { requirePositiveU64 } from "../lib/integers.ts";

const BASIS_POINTS_DENOMINATOR = 10_000n;

export type LaunchEconomicsInput = {
  initialMemeSupply: bigint;
  curveMemeInventory: bigint;
  poolMemeProvision: bigint;
  virtualQuote: bigint;
  migrationQuoteTarget: bigint;
  quoteMigrationFeeBps: bigint;
};

export type LaunchEconomics = {
  terminalCurveMeme: bigint;
  curveMemeReleased: bigint;
  quoteMigrationFee: bigint;
  netQuote: bigint;
  openingValuation: bigint;
  curveTerminalValuation: bigint;
  dexOpeningValuation: bigint;
};

/**
 * Derives launch economics in Meme and Quote atomic units.
 *
 * Terminal Meme and the protocol Quote fee round up. Implied total-supply
 * valuations round down. For a Meme/SUI launch, valuation outputs are MIST.
 */
export function deriveLaunchEconomics(
  input: LaunchEconomicsInput,
): LaunchEconomics {
  const {
    initialMemeSupply,
    curveMemeInventory,
    poolMemeProvision,
    virtualQuote,
    migrationQuoteTarget,
    quoteMigrationFeeBps,
  } = input;

  requirePositiveU64("initialMemeSupply", initialMemeSupply);
  requirePositiveU64("curveMemeInventory", curveMemeInventory);
  requirePositiveU64("poolMemeProvision", poolMemeProvision);
  requirePositiveU64("virtualQuote", virtualQuote);
  requirePositiveU64("migrationQuoteTarget", migrationQuoteTarget);

  if (curveMemeInventory + poolMemeProvision > initialMemeSupply) {
    throw new RangeError(
      "curveMemeInventory + poolMemeProvision cannot exceed initialMemeSupply",
    );
  }
  if (
    quoteMigrationFeeBps < 0n ||
    quoteMigrationFeeBps > BASIS_POINTS_DENOMINATOR
  ) {
    throw new RangeError("quoteMigrationFeeBps must be between 0 and 10,000");
  }

  const effectiveTerminalQuote = virtualQuote + migrationQuoteTarget;
  const terminalCurveMeme = ceilDiv(
    curveMemeInventory * virtualQuote,
    effectiveTerminalQuote,
  );
  const curveMemeReleased = curveMemeInventory - terminalCurveMeme;
  const quoteMigrationFee = ceilDiv(
    migrationQuoteTarget * quoteMigrationFeeBps,
    BASIS_POINTS_DENOMINATOR,
  );
  const netQuote = migrationQuoteTarget - quoteMigrationFee;

  return {
    terminalCurveMeme,
    curveMemeReleased,
    quoteMigrationFee,
    netQuote,
    openingValuation:
      (initialMemeSupply * virtualQuote) / curveMemeInventory,
    curveTerminalValuation:
      (initialMemeSupply * effectiveTerminalQuote) / terminalCurveMeme,
    dexOpeningValuation:
      (initialMemeSupply * netQuote) / poolMemeProvision,
  };
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}
