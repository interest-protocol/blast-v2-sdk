import type { DecodedPresaleEvent, PresaleEventKind } from "./events.ts";
import { presaleEventId, presaleEventModules } from "./events.ts";
import { apportionRaise, apportionSupply } from "./math.ts";
import type {
  BpsShare,
  EligibilityPolicy,
  PresaleLifecycle,
  RecipientPayout,
  UncappedPhase,
} from "./state.ts";

/**
 * One presale rebuilt from its events. Custody fields match `PresaleState`
 * once every event of the presale is applied.
 */
export type PresaleProjection = {
  presaleId: string;
  presaleCapId: string;
  treasuryCapId: string;
  memeType: string;
  quoteType: string;
  lifecycle: PresaleLifecycle;
  tokenSupply: bigint;
  tokenAllocationBps: bigint;
  liquidityTokenAllocationBps: bigint;
  recipientAllocations: BpsShare[];
  burnable: boolean;
  raiseTarget: bigint;
  raiseAllocations: BpsShare[];
  durationMs: bigint;
  liquidityWindowMs: bigint;
  eligibility: EligibilityPolicy;
  uncapped: UncappedPhase | null;
  migrationWitness: string;
  tickSpacing: number;
  feeRate: bigint;
  feeRecipients: BpsShare[];
  rewardsFeeBps: bigint;
  /** Zero until `PresaleOpened`. */
  startMs: bigint;
  endMs: bigint;
  liquidityDeadlineMs: bigint;
  uncappedFromMs: bigint;
  totalCommitments: bigint;
  remainingCommitments: bigint;
  participants: bigint;
  /** Undelivered commitment per wallet (the `Committed` sender). */
  commitments: Readonly<Record<string, bigint>>;
  /** Quote custody balance. */
  quote: bigint;
  tokenAllocation: bigint;
  saleTokens: bigint;
  liquidityTokens: bigint;
  recipientPayouts: RecipientPayout[];
  recipientTokens: bigint;
  raisePayouts: RecipientPayout[];
  /** The vault its migration created; null until then. */
  vaultId: string | null;
};

export type PresaleVaultProjection = {
  vaultId: string;
  presaleId: string;
  poolId: string;
  positionId: string;
  venueType: string;
  memeType: string;
  quoteType: string;
  liquidity: bigint;
  feeRecipients: BpsShare[];
  rewardsFeeBps: bigint;
  migrationMemeResidual: bigint;
  migrationQuoteResidual: bigint;
  rewardsMeme: bigint;
  rewardsQuote: bigint;
  nextRound: bigint;
  lastCheckpoint: bigint | null;
  /** Cumulative LP fees paid to each fee recipient, aligned with `feeRecipients`. */
  recipientMemePaid: bigint[];
  recipientQuotePaid: bigint[];
};

export type PresaleRewardRoundProjection = {
  roundId: string;
  vaultId: string;
  number: bigint;
  startCheckpoint: bigint;
  endCheckpoint: bigint;
  claimDeadlineMs: bigint;
  root: string;
  manifestDigest: string;
  leafCount: bigint;
  memeRemaining: bigint;
  quoteRemaining: bigint;
  paidIndexes: Readonly<Record<string, true>>;
  /** Set by `RoundClosed`, which deletes the round and returns its balances. */
  closed: boolean;
};

export type PresaleEventProjection = {
  appliedEventIds: Readonly<Record<string, true>>;
  eventCounts: Readonly<Record<PresaleEventKind, number>>;
  presales: Readonly<Record<string, PresaleProjection>>;
  vaults: Readonly<Record<string, PresaleVaultProjection>>;
  rounds: Readonly<Record<string, PresaleRewardRoundProjection>>;
};

export function createPresaleEventProjection(): PresaleEventProjection {
  return {
    appliedEventIds: {},
    eventCounts: Object.fromEntries(
      Object.keys(presaleEventModules).map((kind) => [kind, 0]),
    ) as Record<PresaleEventKind, number>,
    presales: {},
    vaults: {},
    rounds: {},
  };
}

/** Applies one event once; replaying an applied event returns `state` unchanged. */
export function reducePresaleEvent(
  state: PresaleEventProjection,
  event: DecodedPresaleEvent,
): PresaleEventProjection {
  const eventId = presaleEventId(event);
  if (state.appliedEventIds[eventId]) return state;
  const next: PresaleEventProjection = {
    ...state,
    appliedEventIds: { ...state.appliedEventIds, [eventId]: true },
    eventCounts: {
      ...state.eventCounts,
      [event.kind]: state.eventCounts[event.kind] + 1,
    },
  };
  return applyPresaleEvent(next, event) ?? applyVaultEvent(next, event);
}

function applyPresaleEvent(
  state: PresaleEventProjection,
  event: DecodedPresaleEvent,
): PresaleEventProjection | null {
  switch (event.kind) {
    case "PresaleCreated":
      return {
        ...state,
        presales: {
          ...state.presales,
          [event.payload.presale_id]: createdPresale(event),
        },
      };
    case "PresaleOpened": {
      const { payload } = event;
      return updatePresale(state, payload.presale_id, () => ({
        lifecycle: "Open",
        startMs: payload.start_ms,
        endMs: payload.end_ms,
        liquidityDeadlineMs: payload.liquidity_deadline_ms,
        uncappedFromMs: payload.uncapped_from_ms,
      }));
    }
    case "Committed": {
      const { payload, sender } = event;
      return updatePresale(state, payload.presale_id, (presale) => ({
        totalCommitments: payload.total_commitments,
        remainingCommitments: payload.total_commitments,
        participants: payload.participants,
        commitments: {
          ...presale.commitments,
          [sender]: payload.wallet_commitment,
        },
        quote: presale.quote + payload.quote,
      }));
    }
    case "PresaleFunded":
      return updatePresale(state, event.payload.presale_id, () => ({
        lifecycle: "Funded",
      }));
    case "PresaleCancelled":
      return updatePresale(state, event.payload.presale_id, () => ({
        lifecycle: "Cancelled",
      }));
    // Migration emits every RaiseAllocated and RecipientAllocated, then PresaleMigrated.
    case "RaiseAllocated": {
      const { payload } = event;
      return updatePresale(state, payload.presale_id, (presale) => ({
        quote: presale.quote - payload.quote,
      }));
    }
    case "RecipientAllocated": {
      const { payload } = event;
      return updatePresale(state, payload.presale_id, (presale) => ({
        recipientTokens: presale.recipientTokens - payload.tokens,
      }));
    }
    case "PresaleMigrated": {
      const { payload } = event;
      return updatePresale(state, payload.presale_id, (presale) => ({
        lifecycle: "Migrated",
        quote: presale.quote - payload.quote,
        liquidityTokens: presale.liquidityTokens - payload.liquidity_tokens,
      }));
    }
    case "Claimed": {
      const { payload } = event;
      return updatePresale(state, payload.presale_id, (presale) => {
        const { [payload.participant]: _, ...commitments } =
          presale.commitments;
        return {
          commitments,
          remainingCommitments: payload.remaining_commitments,
          saleTokens: presale.saleTokens - payload.tokens,
          quote: presale.quote - payload.quote_refund,
        };
      });
    }
    default:
      return null;
  }
}

function applyVaultEvent(
  state: PresaleEventProjection,
  event: DecodedPresaleEvent,
): PresaleEventProjection {
  switch (event.kind) {
    case "PresaleVaultCreated": {
      const { payload } = event;
      const feeRecipients = payload.fee_recipients.map((recipient, i) => ({
        recipient,
        bps: payload.fee_recipient_bps[i]!,
      }));
      const linked = updatePresale(state, payload.presale_id, () => ({
        vaultId: payload.vault_id,
      }));
      return {
        ...linked,
        vaults: {
          ...state.vaults,
          [payload.vault_id]: {
            vaultId: payload.vault_id,
            presaleId: payload.presale_id,
            poolId: payload.pool_id,
            positionId: payload.position_id,
            venueType: event.venueType ?? "",
            memeType: event.memeType,
            quoteType: event.quoteType,
            liquidity: payload.liquidity,
            feeRecipients,
            rewardsFeeBps: payload.rewards_fee_bps,
            migrationMemeResidual: payload.migration_meme_residual,
            migrationQuoteResidual: payload.migration_quote_residual,
            rewardsMeme: 0n,
            rewardsQuote: 0n,
            nextRound: 0n,
            lastCheckpoint: null,
            recipientMemePaid: feeRecipients.map(() => 0n),
            recipientQuotePaid: feeRecipients.map(() => 0n),
          },
        },
      };
    }
    case "FeesCollected": {
      const { payload } = event;
      return updateVault(state, payload.vault_id, (vault) => ({
        rewardsMeme: vault.rewardsMeme + payload.rewards_meme,
        rewardsQuote: vault.rewardsQuote + payload.rewards_quote,
        recipientMemePaid: vault.recipientMemePaid.map(
          (paid, i) => paid + (payload.recipient_meme[i] ?? 0n),
        ),
        recipientQuotePaid: vault.recipientQuotePaid.map(
          (paid, i) => paid + (payload.recipient_quote[i] ?? 0n),
        ),
      }));
    }
    case "MigrationResidualsClaimed":
      return updateVault(state, event.payload.vault_id, () => ({
        migrationMemeResidual: 0n,
        migrationQuoteResidual: 0n,
      }));
    case "RoundPublished": {
      const { payload } = event;
      const updated = updateVault(state, payload.vault_id, () => ({
        rewardsMeme: payload.meme_unallocated,
        rewardsQuote: payload.quote_unallocated,
        nextRound: payload.number + 1n,
        lastCheckpoint: payload.end_checkpoint,
      }));
      return {
        ...updated,
        rounds: {
          ...state.rounds,
          [payload.round_id]: {
            roundId: payload.round_id,
            vaultId: payload.vault_id,
            number: payload.number,
            startCheckpoint: payload.start_checkpoint,
            endCheckpoint: payload.end_checkpoint,
            claimDeadlineMs: payload.claim_deadline_ms,
            root: payload.root,
            manifestDigest: payload.manifest_digest,
            leafCount: payload.leaf_count,
            memeRemaining: payload.meme_amount,
            quoteRemaining: payload.quote_amount,
            paidIndexes: {},
            closed: false,
          },
        },
      };
    }
    case "RewardClaimed": {
      const { payload } = event;
      return updateRound(state, payload.round_id, (round) => ({
        memeRemaining: payload.meme_remaining,
        quoteRemaining: payload.quote_remaining,
        paidIndexes: { ...round.paidIndexes, [payload.index.toString()]: true },
      }));
    }
    case "RoundClosed": {
      const { payload } = event;
      const returned = updateVault(state, payload.vault_id, (vault) => ({
        rewardsMeme: vault.rewardsMeme + payload.meme_returned,
        rewardsQuote: vault.rewardsQuote + payload.quote_returned,
      }));
      return updateRound(returned, payload.round_id, () => ({
        memeRemaining: 0n,
        quoteRemaining: 0n,
        closed: true,
      }));
    }
    default:
      return state;
  }
}

/** `blast_presale::new`'s initial custody, re-derived with the contract's apportionment. */
function createdPresale(
  event: Extract<DecodedPresaleEvent, { kind: "PresaleCreated" }>,
): PresaleProjection {
  const { payload } = event;
  const shares = (recipients: string[], bps: bigint[]) =>
    recipients.map((recipient, i) => ({ recipient, bps: bps[i]! }));
  const recipientAllocations = shares(
    payload.recipients,
    payload.recipient_bps,
  );
  const raiseAllocations = shares(
    payload.raise_recipients,
    payload.raise_recipient_bps,
  );
  const supply = apportionSupply(
    payload.token_supply,
    payload.token_allocation_bps,
    payload.liquidity_token_allocation_bps,
    recipientAllocations,
  );
  const { raisePayouts } = apportionRaise(
    raiseAllocations,
    payload.raise_target,
  );
  return {
    presaleId: payload.presale_id,
    presaleCapId: payload.presale_cap_id,
    treasuryCapId: payload.treasury_cap_id,
    memeType: event.memeType,
    quoteType: event.quoteType,
    lifecycle: "Pending",
    tokenSupply: payload.token_supply,
    tokenAllocationBps: payload.token_allocation_bps,
    liquidityTokenAllocationBps: payload.liquidity_token_allocation_bps,
    recipientAllocations,
    burnable: payload.burnable,
    raiseTarget: payload.raise_target,
    raiseAllocations,
    durationMs: payload.duration_ms,
    liquidityWindowMs: payload.liquidity_window_ms,
    eligibility: payload.eligibility,
    uncapped: payload.uncapped,
    migrationWitness: payload.migration_witness,
    tickSpacing: payload.tick_spacing,
    feeRate: payload.fee_rate,
    feeRecipients: shares(payload.fee_recipients, payload.fee_recipient_bps),
    rewardsFeeBps: payload.rewards_fee_bps,
    startMs: 0n,
    endMs: 0n,
    liquidityDeadlineMs: 0n,
    uncappedFromMs: 0n,
    totalCommitments: 0n,
    remainingCommitments: 0n,
    participants: 0n,
    commitments: {},
    quote: 0n,
    tokenAllocation: supply.tokenAllocation,
    saleTokens: supply.tokenAllocation,
    liquidityTokens: supply.liquidityTokenAllocation,
    recipientPayouts: supply.recipientPayouts,
    recipientTokens: supply.recipientPayouts.reduce(
      (sum, payout) => sum + payout.amount,
      0n,
    ),
    raisePayouts,
    vaultId: null,
  };
}

function updatePresale(
  state: PresaleEventProjection,
  presaleId: string,
  update: (presale: PresaleProjection) => Partial<PresaleProjection>,
): PresaleEventProjection {
  const presale = state.presales[presaleId];
  if (!presale) return state;
  return {
    ...state,
    presales: {
      ...state.presales,
      [presaleId]: { ...presale, ...update(presale) },
    },
  };
}

function updateVault(
  state: PresaleEventProjection,
  vaultId: string,
  update: (vault: PresaleVaultProjection) => Partial<PresaleVaultProjection>,
): PresaleEventProjection {
  const vault = state.vaults[vaultId];
  if (!vault) return state;
  return {
    ...state,
    vaults: { ...state.vaults, [vaultId]: { ...vault, ...update(vault) } },
  };
}

function updateRound(
  state: PresaleEventProjection,
  roundId: string,
  update: (
    round: PresaleRewardRoundProjection,
  ) => Partial<PresaleRewardRoundProjection>,
): PresaleEventProjection {
  const round = state.rounds[roundId];
  if (!round) return state;
  return {
    ...state,
    rounds: { ...state.rounds, [roundId]: { ...round, ...update(round) } },
  };
}
