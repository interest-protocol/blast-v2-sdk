import type {
  DelayedChange,
  Proposal,
} from "@interest-protocol/blast-core/bcs";
import { suiEventId } from "@interest-protocol/blast-core/events";
import type {
  Destination,
  FeeSplit,
} from "@interest-protocol/blast-core/fee-split";
import { apportionFeeSplit } from "@interest-protocol/blast-core/fee-split";
import type { VaultTerms } from "@interest-protocol/blast-core/migration";
import type { DecodedProtocolFeesPaid } from "@interest-protocol/blast-core/protocol-fees";
import { takeCut } from "@interest-protocol/blast-core/protocol-fees";
import type {
  RewardManifest,
  RewardProof,
} from "@interest-protocol/blast-core/rewards/allocations";
import type {
  DecodedVaultDelayedEvent,
  DecodedVaultEvent,
  VaultEventPayloads,
} from "./events.ts";
import type {
  ProtocolBps,
  RoundState,
  RoundTerms,
  VaultState,
} from "./state.ts";
import { rewardIsClaimed } from "./state.ts";

/** `vault::constants::fee_change_delay_ms`: a vault's fixed fee-split and Blast-share notice. */
const FEE_CHANGE_DELAY_MS = 172_800_000n;
/** `vault::constants::round_delay_ms`: a vault's initial round notice. */
const ROUND_DELAY_MS = 7_200_000n;

/** One published holder-reward round, from its events. */
export type VaultRoundProjection = {
  roundId: string;
  number: bigint;
  startCheckpoint: bigint;
  endCheckpoint: bigint;
  claimDeadlineAtMs: bigint;
  root: string;
  manifestDigest: string;
  leafCount: bigint;
  treasury: string;
  /** What the round still owes unpaid leaves. */
  memeRemaining: bigint;
  quoteRemaining: bigint;
  /** Paid leaf indexes, as decimal strings. */
  claimedIndexes: Readonly<Record<string, true>>;
  gasReserveAmount: bigint;
  /** The settled reimbursement; null until `GasReserveSettled`. */
  gasReimbursed: bigint | null;
  /** Set by `RoundClosed`, which deletes the round and returns its balances. */
  closed: boolean;
};

/**
 * One vault, rebuilt from its `blast_vault_events`, its `delayed` events and
 * the core `ProtocolFeesPaid` it emits. The balance fields mirror the
 * object's: what each special route holds, and Blast's held fees.
 */
export type VaultProjection = {
  vaultId: string;
  memeType: string;
  quoteType: string;
  /** The venue witness type that created the vault. */
  venue: string;
  poolId: string;
  positionId: string;
  liquidity: bigint;
  autoLpPositionId: string | null;
  terms: VaultTerms;
  feeSplit: FeeSplit;
  feeSplitDelayMs: bigint;
  pendingFeeSplit: Proposal<FeeSplit> | null;
  protocolBps: ProtocolBps;
  protocolBpsDelayMs: bigint;
  pendingProtocolBps: Proposal<ProtocolBps> | null;
  /** Blast's LP fees held for the sale's partner; zero without one. */
  protocolMeme: bigint;
  protocolQuote: bigint;
  ownerMeme: bigint;
  ownerQuote: bigint;
  autoLpMeme: bigint;
  autoLpQuote: bigint;
  rewardsMeme: bigint;
  rewardsQuote: bigint;
  burnQuote: bigint;
  nextRound: bigint;
  lastCheckpoint: bigint | null;
  roundDelayMs: bigint;
  pendingRoundPublication: Proposal<DelayedChange<RoundTerms>> | null;
  /** Published rounds by number, as decimal strings. */
  rounds: Readonly<Record<string, VaultRoundProjection>>;
};

/** Every vault by ID; `roundVaults` maps a round's ID to its vault's. */
export type VaultEventProjection = {
  appliedEventIds: Readonly<Record<string, true>>;
  vaults: Readonly<Record<string, VaultProjection>>;
  roundVaults: Readonly<Record<string, string>>;
};

export function createVaultEventProjection(): VaultEventProjection {
  return { appliedEventIds: {}, vaults: {}, roundVaults: {} };
}

/**
 * Applies one vault event, vault `delayed` event or core `ProtocolFeesPaid`
 * once; replaying an applied event returns `state` unchanged. Events of a
 * vault before its `VaultCreated` change nothing: the `delayed` creations
 * and the residual payout that precede it in `share_with_position`'s
 * transaction are what `VaultCreated` already carries.
 */
export function reduceVaultEvent(
  state: VaultEventProjection,
  event: DecodedVaultEvent | DecodedVaultDelayedEvent | DecodedProtocolFeesPaid,
): VaultEventProjection {
  const eventId = suiEventId(event.position);
  if (state.appliedEventIds[eventId]) return state;
  const next = {
    ...state,
    appliedEventIds: { ...state.appliedEventIds, [eventId]: true as const },
  };
  if (event.source === "vault") return applyVaultEvent(next, event);
  if (event.source === "core")
    return updateVault(next, event.payload.origin, () => ({
      protocolMeme: 0n,
      protocolQuote: 0n,
    }));
  return applyDelayedEvent(next, event);
}

function applyVaultEvent(
  state: VaultEventProjection,
  event: DecodedVaultEvent,
): VaultEventProjection {
  switch (event.kind) {
    case "VaultCreated":
      return {
        ...state,
        vaults: {
          ...state.vaults,
          [event.payload.vault_id]: createdVault(
            event as Extract<DecodedVaultEvent, { kind: "VaultCreated" }>,
          ),
        },
      };
    case "FeesCollected": {
      const payload = event.payload as VaultEventPayloads["FeesCollected"];
      return updateVault(state, payload.vault_id, (vault) =>
        collected(vault, payload),
      );
    }
    case "OwnerBalancesClaimed":
      return updateVault(state, event.payload.vault_id, (vault) => ({
        ownerMeme: vault.ownerMeme - event.payload.meme_amount,
        ownerQuote: vault.ownerQuote - event.payload.quote_amount,
      }));
    case "AutoLpPositionOpened":
      return updateVault(state, event.payload.vault_id, () => ({
        autoLpPositionId: event.payload.position_id,
      }));
    case "AutoLiquidityAdded":
      return updateVault(state, event.payload.vault_id, () => ({
        autoLpMeme: event.payload.auto_lp_meme_pending,
        autoLpQuote: event.payload.auto_lp_quote_pending,
      }));
    case "BuybackBurned":
      return updateVault(state, event.payload.vault_id, () => ({
        burnQuote: event.payload.burn_quote_pending,
      }));
    case "RoundPublished": {
      const payload = event.payload;
      const published = updateVault(state, payload.vault_id, (vault) => ({
        rewardsMeme: payload.meme_unallocated,
        rewardsQuote: payload.quote_unallocated,
        nextRound: payload.number + 1n,
        lastCheckpoint: payload.end_checkpoint,
        pendingRoundPublication: null,
        rounds: {
          ...vault.rounds,
          [payload.number.toString()]: {
            roundId: payload.round_id,
            number: payload.number,
            startCheckpoint: payload.start_checkpoint,
            endCheckpoint: payload.end_checkpoint,
            claimDeadlineAtMs: payload.claim_deadline_at_ms,
            root: payload.root,
            manifestDigest: payload.manifest_digest,
            leafCount: payload.leaf_count,
            treasury: payload.treasury,
            memeRemaining: payload.meme_amount,
            quoteRemaining: payload.quote_amount,
            claimedIndexes: {},
            gasReserveAmount: payload.gas_reserve_amount,
            gasReimbursed: null,
            closed: false,
          },
        },
      }));
      if (published === state) return state;
      return {
        ...published,
        roundVaults: {
          ...published.roundVaults,
          [payload.round_id]: payload.vault_id,
        },
      };
    }
    case "RewardClaimed": {
      const payload = event.payload;
      return updateRound(state, payload.round_id, null, (round) => ({
        memeRemaining: payload.meme_remaining,
        quoteRemaining: payload.quote_remaining,
        claimedIndexes: {
          ...round.claimedIndexes,
          [payload.index.toString()]: true,
        },
      }));
    }
    case "GasReserveSettled": {
      const payload = event.payload;
      return updateRound(
        state,
        payload.round_id,
        { rewardsQuote: payload.quote_unallocated },
        () => ({ gasReimbursed: payload.reimbursement_amount }),
      );
    }
    case "RoundClosed": {
      const payload = event.payload;
      const vault = state.vaults[payload.vault_id];
      if (!vault) return state;
      return updateRound(
        state,
        payload.round_id,
        {
          rewardsMeme: vault.rewardsMeme + payload.meme_returned,
          rewardsQuote:
            vault.rewardsQuote +
            payload.quote_returned +
            payload.gas_reserve_returned,
        },
        () => ({ memeRemaining: 0n, quoteRemaining: 0n, closed: true }),
      );
    }
  }
}

/** `share_with_position`'s vault: the sealed terms, and residuals settled by their policy. */
function createdVault(
  event: Extract<DecodedVaultEvent, { kind: "VaultCreated" }>,
): VaultProjection {
  const { payload } = event;
  const { terms } = payload;
  const toOwner = terms.residuals === "Owner";
  const heldForPartner = !toOwner && terms.partnerId !== null;
  return {
    vaultId: payload.vault_id,
    memeType: event.memeType,
    quoteType: event.quoteType,
    venue: event.venue,
    poolId: payload.pool_id,
    positionId: payload.position_id,
    liquidity: payload.liquidity,
    autoLpPositionId: null,
    terms,
    feeSplit: terms.feeSplit,
    feeSplitDelayMs: FEE_CHANGE_DELAY_MS,
    pendingFeeSplit: null,
    protocolBps: {
      meme_bps: terms.protocolMemeBps,
      quote_bps: terms.protocolQuoteBps,
    },
    protocolBpsDelayMs: FEE_CHANGE_DELAY_MS,
    pendingProtocolBps: null,
    protocolMeme: heldForPartner ? payload.residual_meme_amount : 0n,
    protocolQuote: heldForPartner ? payload.residual_quote_amount : 0n,
    ownerMeme: toOwner ? payload.residual_meme_amount : 0n,
    ownerQuote: toOwner ? payload.residual_quote_amount : 0n,
    autoLpMeme: 0n,
    autoLpQuote: 0n,
    rewardsMeme: 0n,
    rewardsQuote: 0n,
    burnQuote: 0n,
    nextRound: 0n,
    lastCheckpoint: null,
    roundDelayMs: ROUND_DELAY_MS,
    pendingRoundPublication: null,
    rounds: {},
  };
}

/**
 * One `split_fees`: Blast's cut is held only for a partnered sale (otherwise
 * paid at once), then each route's part lands where its destination says,
 * in the applied split's route order. Address routes and burned Meme leave.
 */
function collected(
  vault: VaultProjection,
  payload: VaultEventPayloads["FeesCollected"],
): Partial<VaultProjection> {
  const change: Partial<VaultProjection> = {};
  if (vault.terms.partnerId !== null) {
    change.protocolMeme = vault.protocolMeme + payload.protocol_meme_amount;
    change.protocolQuote = vault.protocolQuote + payload.protocol_quote_amount;
  }
  vault.feeSplit.routes.forEach(({ destination }, i) => {
    const [meme, quote] = ROUTE_BALANCES[destination.kind];
    if (meme)
      change[meme] =
        (change[meme] ?? vault[meme]) + amountAt(payload, "meme", i);
    if (quote)
      change[quote] =
        (change[quote] ?? vault[quote]) + amountAt(payload, "quote", i);
  });
  return change;
}

/** The balances each destination accrues; address routes are paid and burned Meme leaves. */
const ROUTE_BALANCES: Record<
  Destination["kind"],
  readonly [
    "ownerMeme" | "autoLpMeme" | "rewardsMeme" | null,
    "ownerQuote" | "autoLpQuote" | "rewardsQuote" | "burnQuote" | null,
  ]
> = {
  Address: [null, null],
  Owner: ["ownerMeme", "ownerQuote"],
  AutoLp: ["autoLpMeme", "autoLpQuote"],
  HolderRewards: ["rewardsMeme", "rewardsQuote"],
  Burn: [null, "burnQuote"],
};

function amountAt(
  payload: VaultEventPayloads["FeesCollected"],
  asset: "meme" | "quote",
  i: number,
): bigint {
  const amount = payload[`route_${asset}_amounts`][i];
  if (amount === undefined)
    throw new TypeError("FeesCollected does not match the applied fee split");
  return amount;
}

/** A vault's fee split, Blast share and round slot from their `delayed` lifecycles. */
function applyDelayedEvent(
  state: VaultEventProjection,
  event: DecodedVaultDelayedEvent,
): VaultEventProjection {
  const owner = event.payload.owner;
  switch (event.name) {
    case "FeeSplit":
      switch (event.kind) {
        case "DelayedScheduled":
          return updateVault(state, owner, () => ({
            pendingFeeSplit: proposal(event.payload),
          }));
        case "DelayedCancelled":
          return updateVault(state, owner, () => ({ pendingFeeSplit: null }));
        case "DelayedApplied":
          return updateVault(state, owner, () => ({
            feeSplit: event.payload.value,
            feeSplitDelayMs: event.payload.delay_ms,
            pendingFeeSplit: null,
          }));
      }
      return state;
    case "ProtocolBps":
      switch (event.kind) {
        case "DelayedScheduled":
          return updateVault(state, owner, () => ({
            pendingProtocolBps: proposal(event.payload),
          }));
        case "DelayedCancelled":
          return updateVault(state, owner, () => ({
            pendingProtocolBps: null,
          }));
        case "DelayedApplied":
          return updateVault(state, owner, () => ({
            protocolBps: event.payload.value,
            protocolBpsDelayMs: event.payload.delay_ms,
            pendingProtocolBps: null,
          }));
      }
      return state;
    case "RoundPublication":
      switch (event.kind) {
        case "ActionScheduled":
          return updateVault(state, owner, () => ({
            pendingRoundPublication: {
              value: event.payload.change,
              delay_ms: event.payload.delay_ms,
              ready_at_ms: event.payload.ready_at_ms,
            },
          }));
        case "ActionCancelled":
          return updateVault(state, owner, () => ({
            pendingRoundPublication: null,
          }));
        case "ActionApplied":
          return updateVault(state, owner, () => ({
            pendingRoundPublication: null,
            ...(event.payload.change.kind === "Delay"
              ? { roundDelayMs: event.payload.delay_ms }
              : {}),
          }));
      }
      return state;
    case "Witnesses":
      return state;
  }
}

function proposal<T>(payload: {
  value: T;
  delay_ms: bigint;
  ready_at_ms: bigint;
}): Proposal<T> {
  return {
    value: payload.value,
    delay_ms: payload.delay_ms,
    ready_at_ms: payload.ready_at_ms,
  };
}

function updateVault(
  state: VaultEventProjection,
  vaultId: string,
  update: (vault: VaultProjection) => Partial<VaultProjection>,
): VaultEventProjection {
  const vault = state.vaults[vaultId];
  if (!vault) return state;
  return {
    ...state,
    vaults: { ...state.vaults, [vaultId]: { ...vault, ...update(vault) } },
  };
}

/** Updates a published round and, optionally, its vault. */
function updateRound(
  state: VaultEventProjection,
  roundId: string,
  vaultChange: Partial<VaultProjection> | null,
  update: (round: VaultRoundProjection) => Partial<VaultRoundProjection>,
): VaultEventProjection {
  const vaultId = state.roundVaults[roundId];
  const vault = vaultId === undefined ? undefined : state.vaults[vaultId];
  const round = Object.values(vault?.rounds ?? {}).find(
    (candidate) => candidate.roundId === roundId,
  );
  if (vaultId === undefined || !vault || !round) return state;
  return updateVault(state, vaultId, () => ({
    ...vaultChange,
    rounds: {
      ...vault.rounds,
      [round.number.toString()]: { ...round, ...update(round) },
    },
  }));
}

/**
 * Previews one `vault::split_fees` collection of `grossMeme` and
 * `grossQuote` atoms: Blast's cut of each asset first, `ceil(gross * bps /
 * 10,000)` (`protocol_fees::take_cut`), then the rest apportioned over the
 * applied split's routes (`fee_split::apportion`, largest remainder, earlier
 * routes first). Amounts are in the route order `FeesCollected` reports.
 * Null for an empty collection, which moves and emits nothing.
 */
export function previewFeesCollected(
  vault: Pick<VaultState, "feeSplit" | "protocolBps">,
  grossMeme: bigint,
  grossQuote: bigint,
): Omit<VaultEventPayloads["FeesCollected"], "vault_id"> | null {
  if (grossMeme === 0n && grossQuote === 0n) return null;
  const protocolMeme = takeCut(grossMeme, vault.protocolBps.meme_bps);
  const protocolQuote = takeCut(grossQuote, vault.protocolBps.quote_bps);
  return {
    gross_meme_amount: grossMeme,
    gross_quote_amount: grossQuote,
    protocol_meme_amount: protocolMeme,
    protocol_quote_amount: protocolQuote,
    route_meme_amounts: apportionFeeSplit(
      vault.feeSplit,
      grossMeme - protocolMeme,
    ),
    route_quote_amounts: apportionFeeSplit(
      vault.feeSplit,
      grossQuote - protocolQuote,
    ),
  };
}

/** What a published round commits to; its checkpoints and digest are in `RoundPublished`. */
type RoundCommitment = Pick<
  RoundState,
  "vaultId" | "number" | "root" | "leafCount"
>;

/**
 * Asserts a manifest is the one `round` committed: same vault, number, root
 * and leaf count. The root commits every leaf, so validate the manifest
 * itself first (`validateRewardManifest`) before relaying its proofs.
 */
export function assertRoundMatchesManifest(
  round: RoundCommitment,
  manifest: Pick<RewardManifest, "vaultId" | "number" | "root" | "allocations">,
): void {
  if (
    round.vaultId !== manifest.vaultId ||
    round.number !== BigInt(manifest.number) ||
    round.root !== manifest.root ||
    round.leafCount !== manifest.allocations.length
  )
    throw new Error("manifest does not match the published round");
}

/**
 * The manifest's leaves `round` has not paid. The round's claimed bitmap owns
 * retry state; local transaction logs do not.
 */
export function pendingRewardAllocations(
  round: RoundCommitment & Pick<RoundState, "claimedBitmap">,
  manifest: Pick<RewardManifest, "vaultId" | "number" | "root" | "allocations">,
): RewardProof[] {
  assertRoundMatchesManifest(round, manifest);
  return manifest.allocations.filter(
    (allocation) =>
      !rewardIsClaimed(round.claimedBitmap, Number(allocation.index)),
  );
}
