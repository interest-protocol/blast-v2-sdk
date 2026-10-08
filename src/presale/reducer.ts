import { itemAt } from "../lib/arrays.ts";
import type { DecodedPresaleEvent, PresaleEventKind } from "./events.ts";
import { presaleEventId, presaleEventModules } from "./events.ts";
import { apportionRaise, apportionSupply } from "./math.ts";
import type {
  BpsShare,
  EligibilityPolicy,
  HardCap,
  PresaleLifecycle,
  ProtocolFees,
  RecipientPayout,
  UncappedPhase,
  VestingTerms,
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
  /** Terms each claim locks a participant's tokens under; null when paid out. */
  participantVesting: VestingTerms | null;
  liquidityTokenAllocationBps: bigint;
  recipientAllocations: BpsShare[];
  burnable: boolean;
  raiseTarget: bigint;
  raiseAllocations: BpsShare[];
  durationMs: bigint;
  liquidityWindowMs: bigint;
  eligibility: EligibilityPolicy;
  uncapped: UncappedPhase | null;
  hardCap: HardCap | null;
  migrationWitness: string;
  tickSpacing: number;
  poolFeeRate: bigint;
  feeRecipients: BpsShare[];
  holderRewardsBps: bigint;
  /** When commitments open, which may be after the share; zero until `PresaleOpened`. */
  startMs: bigint;
  /** Scheduled by `PresaleOpened`; an early close's `PresaleFunded` moves it to the close. */
  endMs: bigint;
  /** Scheduled by `PresaleOpened`; an early close's `PresaleFunded` counts it from the close. */
  liquidityDeadlineMs: bigint;
  uncappedFromMs: bigint;
  /** When the hard cap takes hold; null without one, set by `PresaleOpened`. */
  hardCapFromMs: bigint | null;
  totalCommitments: bigint;
  /** Wallets holding an undelivered commitment; each claim releases one. */
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
  /**
   * The `blast_fun_linear_vesting::Vesting` schedule migration created for
   * each vesting token recipient, by recipient address.
   */
  recipientVestingIds: Readonly<Record<string, string>>;
  /** The schedule migration created for each vesting raise recipient. */
  raiseVestingIds: Readonly<Record<string, string>>;
  /** The schedule each participant's claim created under participant vesting. */
  participantVestingIds: Readonly<Record<string, string>>;
  /**
   * Blast's rates: snapshotted at creation, then replaced by each
   * `ProtocolFeesChanged` before the start.
   */
  protocolFees: ProtocolFees;
  /** Blast's share of the raise, paid on migration. */
  protocolQuote: bigint;
  /** Blast's token share still in custody. */
  protocolTokens: bigint;
  /** The Blast partner named at creation; null until `PresaleOpened` names one. */
  partnerId: string | null;
  /**
   * Blast's raise fee a partnered sale's migration holds until
   * `pay_protocol_fees_with_partner`; null before migration, after the payout, and without a
   * partner.
   */
  unpaidProtocolQuote: bigint | null;
  /**
   * What the partner received of Blast's raise fee; null until a partnered
   * sale's payout.
   */
  partnerQuote: bigint | null;
  /** Where Blast's fees were paid; null until then. */
  protocolDestination: string | null;
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
  holderRewardsBps: bigint;
  /**
   * Blast's shares of each collected LP-fee asset: snapshotted at migration,
   * then replaced by each `ProtocolLpFeesChanged`.
   */
  protocolLpFeeMemeBps: bigint;
  protocolLpFeeQuoteBps: bigint;
  migrationMemeResidual: bigint;
  migrationQuoteResidual: bigint;
  /** Holder-reward share not yet reserved by a round. */
  holderRewardsMeme: bigint;
  holderRewardsQuote: bigint;
  nextRound: bigint;
  lastCheckpoint: bigint | null;
  /** Cumulative LP fees paid to each fee recipient, aligned with `feeRecipients`. */
  feeRecipientMemePaid: bigint[];
  feeRecipientQuotePaid: bigint[];
  /** Cumulative LP fees paid to Blast. */
  protocolMemePaid: bigint;
  protocolQuotePaid: bigint;
  /** Blast's LP fees a partnered vault holds for its next partner payout. */
  protocolMemeHeld: bigint;
  protocolQuoteHeld: bigint;
  /** Cumulative cut of Blast's LP fees paid to the sale's partner. */
  partnerMemePaid: bigint;
  partnerQuotePaid: bigint;
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
        hardCapFromMs: payload.hard_cap_from_ms,
        partnerId: payload.partner_id,
      }));
    }
    // Before the start: Blast's tokens move to or from the sale allocation, its Quote to or from
    // the LP's.
    case "ProtocolFeesChanged": {
      const { payload } = event;
      return updatePresale(state, payload.presale_id, () => ({
        protocolFees: {
          raiseBps: payload.protocol_raise_bps,
          tokenBps: payload.protocol_token_bps,
          lpFeeMemeBps: payload.protocol_lp_fee_meme_bps,
          lpFeeQuoteBps: payload.protocol_lp_fee_quote_bps,
        },
        protocolQuote: payload.protocol_quote,
        protocolTokens: payload.protocol_tokens,
        tokenAllocation: payload.token_allocation,
        saleTokens: payload.token_allocation,
      }));
    }
    case "Committed": {
      const { payload, sender } = event;
      return updatePresale(state, payload.presale_id, (presale) => ({
        totalCommitments: payload.total_commitments,
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
        endMs: event.payload.end_ms,
        liquidityDeadlineMs: event.payload.liquidity_deadline_ms,
      }));
    case "PresaleCancelled":
      return updatePresale(state, event.payload.presale_id, () => ({
        lifecycle: "Cancelled",
      }));
    // Migration emits ProtocolFeesPaid, every RaiseAllocated and RecipientAllocated, then
    // PresaleMigrated. A partnered sale's migration holds Blast's fees instead, and its
    // `pay_protocol_fees_with_partner` emits ProtocolFeesPaid later, out of the held raise fee.
    case "ProtocolFeesPaid": {
      const { payload } = event;
      return updatePresale(state, payload.presale_id, (presale) => ({
        ...protocolQuotePaid(presale, payload),
        protocolTokens: presale.protocolTokens - payload.tokens,
        protocolDestination: payload.destination,
      }));
    }
    case "RaiseAllocated": {
      const { payload } = event;
      return updatePresale(state, payload.presale_id, (presale) => ({
        quote: presale.quote - payload.quote,
        raiseVestingIds:
          payload.vesting_id === null
            ? presale.raiseVestingIds
            : {
                ...presale.raiseVestingIds,
                [payload.recipient]: payload.vesting_id,
              },
      }));
    }
    case "RecipientAllocated": {
      const { payload } = event;
      return updatePresale(state, payload.presale_id, (presale) => ({
        recipientTokens: presale.recipientTokens - payload.tokens,
        recipientVestingIds:
          payload.vesting_id === null
            ? presale.recipientVestingIds
            : {
                ...presale.recipientVestingIds,
                [payload.recipient]: payload.vesting_id,
              },
      }));
    }
    case "PresaleMigrated": {
      const { payload } = event;
      return updatePresale(state, payload.presale_id, (presale) => {
        const unpaidProtocolQuote = heldProtocolQuote(presale);
        return {
          lifecycle: "Migrated",
          quote:
            presale.quote -
            payload.liquidity_quote -
            (unpaidProtocolQuote ?? 0n),
          liquidityTokens: presale.liquidityTokens - payload.liquidity_tokens,
          unpaidProtocolQuote,
        };
      });
    }
    case "Claimed": {
      const { payload } = event;
      return updatePresale(state, payload.presale_id, (presale) => {
        const { [payload.participant]: _, ...commitments } =
          presale.commitments;
        return {
          commitments,
          participants: payload.remaining_participants,
          saleTokens: presale.saleTokens - payload.tokens,
          quote: presale.quote - payload.quote_refund,
          participantVestingIds:
            payload.vesting_id === null
              ? presale.participantVestingIds
              : {
                  ...presale.participantVestingIds,
                  [payload.participant]: payload.vesting_id,
                },
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
    case "VaultCreated": {
      const { payload } = event;
      const feeRecipients = payload.fee_recipients.map((recipient, i) => ({
        recipient,
        bps: itemAt(payload.fee_recipient_bps, i),
        vesting: null,
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
            venueType: event.venueType,
            memeType: event.memeType,
            quoteType: event.quoteType,
            liquidity: payload.liquidity,
            feeRecipients,
            holderRewardsBps: payload.holder_rewards_bps,
            protocolLpFeeMemeBps: payload.protocol_lp_fee_meme_bps,
            protocolLpFeeQuoteBps: payload.protocol_lp_fee_quote_bps,
            migrationMemeResidual: payload.migration_meme_residual,
            migrationQuoteResidual: payload.migration_quote_residual,
            holderRewardsMeme: 0n,
            holderRewardsQuote: 0n,
            nextRound: 0n,
            lastCheckpoint: null,
            feeRecipientMemePaid: feeRecipients.map(() => 0n),
            feeRecipientQuotePaid: feeRecipients.map(() => 0n),
            protocolMemePaid: 0n,
            protocolQuotePaid: 0n,
            protocolMemeHeld: 0n,
            protocolQuoteHeld: 0n,
            partnerMemePaid: 0n,
            partnerQuotePaid: 0n,
          },
        },
      };
    }
    case "FeesCollected": {
      const { payload } = event;
      return updateVault(state, payload.vault_id, (vault) => ({
        holderRewardsMeme:
          vault.holderRewardsMeme + payload.holder_rewards_meme,
        holderRewardsQuote:
          vault.holderRewardsQuote + payload.holder_rewards_quote,
        feeRecipientMemePaid: vault.feeRecipientMemePaid.map(
          (paid, i) => paid + (payload.fee_recipient_meme[i] ?? 0n),
        ),
        feeRecipientQuotePaid: vault.feeRecipientQuotePaid.map(
          (paid, i) => paid + (payload.fee_recipient_quote[i] ?? 0n),
        ),
        // A partnered vault holds Blast's LP fees: no destination was paid.
        ...(payload.protocol_destination === null
          ? {
              protocolMemeHeld: vault.protocolMemeHeld + payload.protocol_meme,
              protocolQuoteHeld:
                vault.protocolQuoteHeld + payload.protocol_quote,
            }
          : {
              protocolMemePaid: vault.protocolMemePaid + payload.protocol_meme,
              protocolQuotePaid:
                vault.protocolQuotePaid + payload.protocol_quote,
            }),
      }));
    }
    case "ProtocolLpFeesPaid": {
      const { payload } = event;
      return updateVault(state, payload.vault_id, (vault) => ({
        protocolMemeHeld: 0n,
        protocolQuoteHeld: 0n,
        protocolMemePaid: vault.protocolMemePaid + payload.protocol_meme,
        protocolQuotePaid: vault.protocolQuotePaid + payload.protocol_quote,
        partnerMemePaid: vault.partnerMemePaid + payload.partner_meme,
        partnerQuotePaid: vault.partnerQuotePaid + payload.partner_quote,
      }));
    }
    case "ProtocolLpFeesChanged": {
      const { payload } = event;
      return updateVault(state, payload.vault_id, () => ({
        protocolLpFeeMemeBps: payload.protocol_lp_fee_meme_bps,
        protocolLpFeeQuoteBps: payload.protocol_lp_fee_quote_bps,
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
        holderRewardsMeme: payload.meme_unallocated,
        holderRewardsQuote: payload.quote_unallocated,
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
        holderRewardsMeme: vault.holderRewardsMeme + payload.meme_returned,
        holderRewardsQuote: vault.holderRewardsQuote + payload.quote_returned,
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

/** `blast_presale::finalize`'s initial custody, re-derived with the contract's apportionment. */
function createdPresale(
  event: Extract<DecodedPresaleEvent, { kind: "PresaleCreated" }>,
): PresaleProjection {
  const { payload } = event;
  const shares = (
    recipients: string[],
    bps: bigint[],
    vesting: readonly (VestingTerms | null)[] = [],
  ): BpsShare[] =>
    recipients.map((recipient, i) => ({
      recipient,
      bps: itemAt(bps, i),
      vesting: vesting[i] ?? null,
    }));
  const recipientAllocations = shares(
    payload.recipients,
    payload.recipient_bps,
    payload.recipient_vesting,
  );
  const raiseAllocations = shares(
    payload.raise_recipients,
    payload.raise_recipient_bps,
    payload.raise_recipient_vesting,
  );
  const protocolFees: ProtocolFees = {
    raiseBps: payload.protocol_raise_bps,
    tokenBps: payload.protocol_token_bps,
    lpFeeMemeBps: payload.protocol_lp_fee_meme_bps,
    lpFeeQuoteBps: payload.protocol_lp_fee_quote_bps,
  };
  const supply = apportionSupply(
    payload.token_supply,
    payload.token_allocation_bps,
    payload.liquidity_token_allocation_bps,
    protocolFees.tokenBps,
    recipientAllocations,
  );
  const { raisePayouts } = apportionRaise(
    raiseAllocations,
    protocolFees.raiseBps,
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
    participantVesting: payload.participant_vesting,
    liquidityTokenAllocationBps: payload.liquidity_token_allocation_bps,
    recipientAllocations,
    burnable: payload.burnable,
    raiseTarget: payload.raise_target,
    raiseAllocations,
    durationMs: payload.duration_ms,
    liquidityWindowMs: payload.liquidity_window_ms,
    eligibility: payload.eligibility,
    uncapped: payload.uncapped,
    hardCap: payload.hard_cap,
    migrationWitness: payload.migration_witness,
    tickSpacing: payload.tick_spacing,
    poolFeeRate: payload.pool_fee_rate,
    feeRecipients: shares(payload.fee_recipients, payload.fee_recipient_bps),
    holderRewardsBps: payload.holder_rewards_bps,
    startMs: 0n,
    endMs: 0n,
    liquidityDeadlineMs: 0n,
    uncappedFromMs: 0n,
    hardCapFromMs: null,
    totalCommitments: 0n,
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
    recipientVestingIds: {},
    raiseVestingIds: {},
    participantVestingIds: {},
    protocolFees,
    protocolQuote: payload.protocol_quote,
    protocolTokens: payload.protocol_tokens,
    partnerId: null,
    unpaidProtocolQuote: null,
    partnerQuote: null,
    protocolDestination: null,
    vaultId: null,
  };
}

/** Blast's raise fee a partnered migration holds back from custody; null without a partner. */
function heldProtocolQuote(presale: PresaleProjection): bigint | null {
  if (presale.partnerId === null) return null;
  return presale.protocolQuote;
}

/**
 * How `ProtocolFeesPaid` settles Blast's raise fee: out of Quote custody at a
 * sale's migration, or out of the held fee at a partnered sale's payout.
 */
function protocolQuotePaid(
  presale: PresaleProjection,
  payload: { quote: bigint; partner_quote: bigint },
): Partial<PresaleProjection> {
  if (presale.partnerId === null) {
    return { quote: presale.quote - payload.quote };
  }
  return { unpaidProtocolQuote: null, partnerQuote: payload.partner_quote };
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
