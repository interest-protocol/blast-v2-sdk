import { bcs } from "@mysten/sui/bcs";
import { addressBcs, u64Bcs } from "./bcs.ts";

/**
 * `blast_core::payout::VestingTerms`: `periods` equal steps of
 * `periodDurationMs` each, the first available `cliffDelayMs` after the
 * payout.
 */
export type VestingTerms = {
  cliffDelayMs: bigint;
  periodDurationMs: bigint;
  periods: bigint;
};

/**
 * `blast_core::payout::Recipient`: where a payout goes, paid outright when
 * `vestingTerms` is null and locked under them otherwise.
 */
export type Recipient = {
  destination: string;
  vestingTerms: VestingTerms | null;
};

export const vestingTermsBcs = bcs
  .struct("VestingTerms", {
    cliff_delay_ms: u64Bcs,
    period_duration_ms: u64Bcs,
    periods: u64Bcs,
  })
  .transform({
    input: (terms: VestingTerms) => ({
      cliff_delay_ms: terms.cliffDelayMs,
      period_duration_ms: terms.periodDurationMs,
      periods: terms.periods,
    }),
    output: (terms): VestingTerms => ({
      cliffDelayMs: terms.cliff_delay_ms,
      periodDurationMs: terms.period_duration_ms,
      periods: terms.periods,
    }),
  });

export const recipientBcs = bcs
  .struct("Recipient", {
    destination: addressBcs,
    vesting_terms: bcs.option(vestingTermsBcs),
  })
  .transform({
    input: (recipient: Recipient) => ({
      destination: recipient.destination,
      vesting_terms: recipient.vestingTerms,
    }),
    output: (recipient): Recipient => ({
      destination: recipient.destination,
      vestingTerms: recipient.vesting_terms,
    }),
  });
