import { suiEventId } from "../lib/events.ts";
import type { DecodedAutoLpEvent } from "./events.ts";
export type AutoLpProjection = {
  poolId: string;
  creatorCapId: string;
  positionId: string;
  executor: string;
  memeAmount: bigint;
  quoteAmount: bigint;
  shares: bigint;
};
export type AutoLpReplayState = {
  vaults: Map<string, AutoLpProjection>;
  applied: Set<string>;
  checkpoint: bigint;
  version: bigint | null;
};
export function createAutoLpReplayState(): AutoLpReplayState {
  return {
    vaults: new Map(),
    applied: new Set(),
    checkpoint: 0n,
    version: null,
  };
}
/** Replays custody totals, not authority to execute. Pool/position types and owners require object reads. */
export function applyAutoLpEvent(
  state: AutoLpReplayState,
  event: DecodedAutoLpEvent,
): void {
  const id = suiEventId(event.position);
  if (state.applied.has(id)) return;
  if (event.position.checkpoint < state.checkpoint)
    throw new Error("AutoLP replay is out of order");
  switch (event.kind) {
    case "vault.Enrolled":
      applyvaultEnrolled(state, event);
      break;
    case "vault.FeesCollected":
    case "vault.Contributed":
    case "vault.Compounded":
      applyvaultCompounded(state, event);
      break;
    case "vault.VersionActivated":
      applyvaultVersionActivated(state, event);
      break;
  }
  state.applied.add(id);
  state.checkpoint = event.position.checkpoint;
}

function applyvaultEnrolled(
  state: AutoLpReplayState,
  event: Extract<DecodedAutoLpEvent, { kind: "vault.Enrolled" }>,
) {
  const p = event.payload;
  if (state.vaults.has(p.vault_id))
    throw new Error("duplicate AutoLP enrollment");
  state.vaults.set(p.vault_id, {
    poolId: p.pool_id,
    creatorCapId: p.creator_cap_id,
    positionId: p.position_id,
    executor: p.executor,
    memeAmount: 0n,
    quoteAmount: 0n,
    shares: 0n,
  });
}

function applyvaultCompounded(
  state: AutoLpReplayState,
  event: Extract<
    DecodedAutoLpEvent,
    { kind: "vault.FeesCollected" | "vault.Contributed" | "vault.Compounded" }
  >,
) {
  const p = event.payload;
  const vault = state.vaults.get(p.vault_id);
  if (!vault) throw new Error("missing AutoLP enrollment history");
  const sign = event.kind === "vault.Compounded" ? -1n : 1n;
  if (
    vault.memeAmount + sign * p.meme !== p.meme_total ||
    vault.quoteAmount + sign * p.quote !== p.quote_total
  )
    throw new Error("AutoLP custody conservation mismatch");
  const shares =
    vault.shares +
    (event.kind === "vault.Compounded" ? event.payload.shares : 0n);
  state.vaults.set(p.vault_id, {
    ...vault,
    memeAmount: p.meme_total,
    quoteAmount: p.quote_total,
    shares,
  });
}

function applyvaultVersionActivated(
  state: AutoLpReplayState,
  event: Extract<DecodedAutoLpEvent, { kind: "vault.VersionActivated" }>,
) {
  const p = event.payload;
  if (
    p.version !== p.previous_version + 1n ||
    (state.version !== null && state.version !== p.previous_version)
  )
    throw new Error("AutoLP generation history mismatch");
  state.version = p.version;
}
