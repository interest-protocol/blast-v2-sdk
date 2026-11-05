import { itemAt } from "@interest-protocol/blast-core/arrays";
import type { FeeSplit } from "@interest-protocol/blast-core/fee-split";
import type {
  Recipient,
  VestingTerms,
} from "@interest-protocol/blast-core/payout";
import type {
  DecodedProtocolFeesPaid,
  ProtocolFeesPaid,
} from "@interest-protocol/blast-core/protocol-fees";
import { normalizeSuiObjectId } from "@mysten/sui/utils";
import type {
  DecodedPresaleDelayedEvent,
  DecodedPresaleEvent,
  DecodedPresalePolicyEvent,
  PresaleEventKind,
} from "./events.ts";
import { presaleEventId, presaleEventModules } from "./events.ts";
import { apportionRaise, apportionSupply } from "./math.ts";
import type {
  EligibilityPolicy,
  HardCap,
  PresaleLifecycle,
  ProtocolFees,
  RecipientPayout,
  RecipientShare,
  UncappedPhase,
} from "./state.ts";

/**
 * One presale rebuilt from its events and the core `ProtocolFeesPaid` events
 * of its ledger. Custody fields match `PresaleState` once every event of the
 * presale is applied.
 */
export type PresaleProjection = {
  presaleId: string;
  presaleCapId: string;
  treasuryCapId: string;
  saleTokenType: string;
  quoteType: string;
  lifecycle: PresaleLifecycle;
  tokenSupply: bigint;
  tokenAllocationBps: bigint;
  /** Terms each claim locks a participant's tokens under; null when paid out. */
  participantVesting: VestingTerms | null;
  liquidityTokenAllocationBps: bigint;
  recipientAllocations: RecipientShare[];
  burnable: boolean;
  raiseTarget: bigint;
  raiseAllocations: RecipientShare[];
  durationMs: bigint;
  liquidityWindowMs: bigint;
  eligibility: EligibilityPolicy;
  uncapped: UncappedPhase | null;
  hardCap: HardCap | null;
  /** The venue witness type the sale migrates to. */
  venue: string;
  /** The LP-fee split the sale's vault starts with. */
  feeSplit: FeeSplit;
  /** When commitments open; zero until `PresaleOpened`. */
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
  /** The `Vesting` schedule migration created for each vesting token recipient. */
  recipientVestingIds: Readonly<Record<string, string>>;
  /** The schedule migration created for each vesting raise recipient. */
  raiseVestingIds: Readonly<Record<string, string>>;
  /** The schedule each participant's claim created under participant vesting. */
  participantVestingIds: Readonly<Record<string, string>>;
  /** Blast's rates: snapshotted at creation, then replaced by each `ProtocolFeesChanged`. */
  protocolFees: ProtocolFees;
  /** Blast's share of the raise, moved into the fee ledger on migration. */
  protocolQuote: bigint;
  /** Blast's token share still in custody; zero once migrated. */
  protocolTokens: bigint;
  /** The Blast partner named at creation; null until `PresaleOpened` names one. */
  partnerId: string | null;
  /** Blast's tokens and Quote the fee ledger holds for a partnered sale's payout. */
  feeLedgerMeme: bigint;
  feeLedgerQuote: bigint;
  /** The ledger's last payout; null until Blast's fees are paid. */
  protocolFeesPaid: ProtocolFeesPaid | null;
};

/** The `FeePolicy` and `CreationPolicy` rebuilt from their events. */
export type PresalePolicyProjection = {
  /** Null until the fee policy's `DelayedCreated`. */
  fees: ProtocolFees | null;
  /** Quote types allowed, from `QuoteAllowed`. */
  quotes: Readonly<Record<string, true>>;
  /** Admitted venue witness types. */
  venues: Readonly<Record<string, true>>;
  /**
   * Latest proposals by `presaleDelayedPolicyKey`. Crossing ready_at_ms never
   * applies their values.
   */
  pendingPolicies: Readonly<Record<string, DecodedPresaleDelayedEvent>>;
  /** Applied delays by `presaleDelayedPolicyKey`, without a set member. */
  policyDelays: Readonly<Record<string, bigint>>;
};

export type PresaleEventProjection = {
  appliedEventIds: Readonly<Record<string, true>>;
  /** Presale events by kind; delayed, policy and core events are not counted. */
  eventCounts: Readonly<Record<PresaleEventKind, number>>;
  presales: Readonly<Record<string, PresaleProjection>>;
  policy: PresalePolicyProjection;
};

export function createPresaleEventProjection(): PresaleEventProjection {
  return {
    appliedEventIds: {},
    eventCounts: Object.fromEntries(
      Object.keys(presaleEventModules).map((kind) => [kind, 0]),
    ) as Record<PresaleEventKind, number>,
    presales: {},
    policy: {
      fees: null,
      quotes: {},
      venues: {},
      pendingPolicies: {},
      policyDelays: {},
    },
  };
}

export type PresaleProjectionEvent =
  | DecodedPresaleEvent
  | DecodedPresaleDelayedEvent
  | DecodedPresalePolicyEvent
  | DecodedProtocolFeesPaid;

/**
 * Applies one presale event, one delayed event from
 * `decodePresaleDelayedEvent`, one `QuoteAllowed`, or one core
 * `ProtocolFeesPaid` whose origin is a projected presale, once; replaying an
 * applied event returns `state` unchanged.
 */
export function reducePresaleEvent(
  state: PresaleEventProjection,
  event: PresaleProjectionEvent,
): PresaleEventProjection {
  const eventId = presaleEventId(event);
  if (state.appliedEventIds[eventId]) return state;
  const applied = {
    ...state,
    appliedEventIds: { ...state.appliedEventIds, [eventId]: true as const },
  };
  switch (event.source) {
    case "delayed":
      return { ...applied, policy: reduceDelayed(state.policy, event) };
    case "presale-policy": {
      const { [event.quoteType]: _, ...quotes } = state.policy.quotes;
      return {
        ...applied,
        policy: {
          ...state.policy,
          quotes: event.payload.allowed
            ? { ...quotes, [event.quoteType]: true }
            : quotes,
        },
      };
    }
    case "core":
      // A partnered sale's payout, or an unpartnered sale's at migration.
      return updatePresale(
        applied,
        normalizeSuiObjectId(event.payload.origin),
        () => ({
          feeLedgerMeme: 0n,
          feeLedgerQuote: 0n,
          protocolFeesPaid: event.payload,
        }),
      );
    case "presale":
      return applyPresaleEvent(
        {
          ...applied,
          eventCounts: {
            ...state.eventCounts,
            [event.kind]: state.eventCounts[event.kind] + 1,
          },
        },
        event,
      );
  }
}

function applyPresaleEvent(
  state: PresaleEventProjection,
  event: DecodedPresaleEvent,
): PresaleEventProjection {
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
    // Migration moves the raise out of custody (Blast's share into the ledger, paid at once
    // without a partner), then emits every RaiseAllocated and RecipientAllocated, then
    // PresaleMigrated.
    case "RaiseAllocated": {
      const { payload } = event;
      return updatePresale(state, payload.presale_id, (presale) => ({
        raiseVestingIds: withVesting(
          presale.raiseVestingIds,
          payload.recipient,
          payload.vesting_id,
        ),
      }));
    }
    case "RecipientAllocated": {
      const { payload } = event;
      return updatePresale(state, payload.presale_id, (presale) => ({
        recipientTokens: presale.recipientTokens - payload.tokens,
        recipientVestingIds: withVesting(
          presale.recipientVestingIds,
          payload.recipient,
          payload.vesting_id,
        ),
      }));
    }
    case "PresaleMigrated": {
      const { payload } = event;
      return updatePresale(state, payload.presale_id, (presale) => ({
        lifecycle: "Migrated",
        quote: presale.quote - presale.raiseTarget,
        liquidityTokens: presale.liquidityTokens - payload.liquidity_tokens,
        protocolTokens: 0n,
        ...(presale.partnerId === null
          ? {}
          : {
              feeLedgerMeme: presale.protocolTokens,
              feeLedgerQuote: presale.protocolQuote,
            }),
      }));
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
          participantVestingIds: withVesting(
            presale.participantVestingIds,
            payload.participant,
            payload.vesting_id,
          ),
        };
      });
    }
  }
}

/** `blast_presale::finalize`'s initial custody, re-derived with the contract's apportionment. */
function createdPresale(
  event: Extract<DecodedPresaleEvent, { kind: "PresaleCreated" }>,
): PresaleProjection {
  const { payload } = event;
  const shares = (recipients: Recipient[], bps: bigint[]): RecipientShare[] =>
    recipients.map((recipient, i) => ({ recipient, bps: itemAt(bps, i) }));
  const recipientAllocations = shares(
    payload.recipients,
    payload.recipient_bps,
  );
  const raiseAllocations = shares(
    payload.raise_recipients,
    payload.raise_recipient_bps,
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
    saleTokenType: event.saleTokenType,
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
    venue: payload.venue,
    feeSplit: payload.fee_split,
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
    feeLedgerMeme: 0n,
    feeLedgerQuote: 0n,
    protocolFeesPaid: null,
  };
}

function withVesting(
  ids: Readonly<Record<string, string>>,
  owner: string,
  vestingId: string | null,
): Readonly<Record<string, string>> {
  return vestingId === null ? ids : { ...ids, [owner]: vestingId };
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

/**
 * The projection key of a delayed value: its registry name, then the member
 * for a venue admission.
 */
export function presaleDelayedPolicyKey(
  event: Pick<DecodedPresaleDelayedEvent, "name" | "payload">,
): string {
  if (
    event.name === "Venues" &&
    "change" in event.payload &&
    event.payload.change.kind === "Admission"
  )
    return `${event.name}:${event.payload.change.member}`;
  return event.name;
}

/** Applied fees and venues, proposals and applied delays; readiness alone changes nothing. */
function reduceDelayed(
  state: PresalePolicyProjection,
  event: DecodedPresaleDelayedEvent,
): PresalePolicyProjection {
  const key = presaleDelayedPolicyKey(event);
  const pending = { ...state.pendingPolicies };
  const delays = { ...state.policyDelays };
  let { fees, venues } = state;
  switch (event.kind) {
    case "DelayedScheduled":
    case "SetScheduled":
      pending[key] = event;
      break;
    case "DelayedCancelled":
    case "SetCancelled":
      delete pending[key];
      break;
    case "DelayedApplied":
      delete pending[key];
      delays[key] = event.payload.delay_ms;
      if (event.name === "Fees") fees = event.payload.value;
      break;
    case "SetApplied":
      delete pending[key];
      // An admission's delay_ms is the delay it waited, not a new set delay.
      if (event.payload.change.kind === "Delay")
        delays[key] = event.payload.delay_ms;
      else venues = { ...venues, [event.payload.change.member]: true };
      break;
    case "DelayedCreated":
      delays[key] = event.payload.delay_ms;
      if (event.name === "Fees") fees = event.payload.value;
      break;
    case "SetCreated":
      delays[key] = event.payload.delay_ms;
      break;
    case "MemberRemoved": {
      const { [event.payload.member]: _, ...rest } = venues;
      venues = rest;
      break;
    }
    default:
      return state;
  }
  return {
    ...state,
    fees,
    venues,
    pendingPolicies: pending,
    policyDelays: delays,
  };
}
