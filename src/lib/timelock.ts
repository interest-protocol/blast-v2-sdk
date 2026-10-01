import type { BcsType } from "@mysten/sui/bcs";
import { bcs } from "@mysten/sui/bcs";

import { u64Bcs } from "./bcs.ts";

/**
 * Mirrors `blast_fun_timelock::Timelocked<T>`: `before` until `atMs`, then
 * `after`. `after` is the scheduled value; `delayMs` is fixed at creation.
 */
export type Timelocked<T> = {
  before: T;
  after: T;
  atMs: bigint;
  delayMs: bigint;
};

export function timelockedBcs<T>(value: BcsType<T, T>) {
  return bcs
    .struct("Timelocked", {
      before: value,
      after: value,
      at_ms: u64Bcs,
      delay_ms: u64Bcs,
    })
    .transform({
      input: (timelocked: Timelocked<T>) => ({
        before: timelocked.before,
        after: timelocked.after,
        at_ms: timelocked.atMs,
        delay_ms: timelocked.delayMs,
      }),
      output: (timelocked): Timelocked<T> => ({
        before: timelocked.before,
        after: timelocked.after,
        atMs: timelocked.at_ms,
        delayMs: timelocked.delay_ms,
      }),
    });
}

/** Mirrors `blast_fun_timelock::value`: the value in force at `nowMs`. */
export function timelockedValue<T>(
  timelocked: Timelocked<T>,
  nowMs: bigint,
): T {
  return nowMs >= timelocked.atMs ? timelocked.after : timelocked.before;
}
