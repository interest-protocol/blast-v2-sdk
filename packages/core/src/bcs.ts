import type { BcsType } from "@mysten/sui/bcs";
import { bcs } from "@mysten/sui/bcs";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
} from "@mysten/sui/utils";

export const suiIdBcs = bcs.struct("ID", { bytes: bcs.Address });
export const suiUidBcs = bcs.struct("UID", { id: suiIdBcs });
export const suiBalanceBcs = bcs.struct("Balance", { value: bcs.u64() });

export const suiObjectIdBcs = suiIdBcs.transform({
  input: (value: string) => ({ bytes: normalizeSuiObjectId(value) }),
  output: (value) => normalizeSuiObjectId(value.bytes),
});

const asciiStringBcs = bcs.struct("AsciiString", {
  bytes: bcs.vector(bcs.u8()),
});

/**
 * `std::type_name::TypeName`. Move stores the type with every address as 64
 * hex digits and no `0x`; the SDK reads and writes normalized struct tags, so
 * `serialize(parse(bytes))` returns the Move bytes.
 */
export const moveTypeNameBcs = bcs
  .struct("TypeName", { name: asciiStringBcs })
  .transform({
    input: (value: string) => ({
      name: {
        bytes: Array.from(
          new TextEncoder().encode(
            normalizeStructTag(value).replace(/0x([0-9a-f]{64})/g, "$1"),
          ),
        ),
      },
    }),
    output: (value) =>
      normalizeStructTag(
        new TextDecoder().decode(Uint8Array.from(value.name.bytes)),
      ),
  });

export const u64Bcs = bcs.u64().transform({
  input: (value: bigint) => value,
  output: (value) => BigInt(value),
});

/** A `Balance<T>` decoded as its atomic amount. */
export const balanceBcs = bcs.struct("Balance", { value: u64Bcs }).transform({
  input: (value: bigint) => ({ value }),
  output: (balance) => balance.value,
});

export const addressBcs = bcs.Address.transform({
  input: (value: string) => normalizeSuiAddress(value),
  output: (value) => normalizeSuiAddress(value),
});

/**
 * A zero-field Move key such as `TradeFeesKey()`: Move gives it one
 * `dummy_field: bool`, so it encodes as one byte.
 */
export const unitKeyBcs = bcs
  .struct("Key", { dummy_field: bcs.bool() })
  .transform({
    input: (_: null) => ({ dummy_field: false }),
    output: (): null => null,
  });

/** `0x2::vec_set::VecSet<E>`: its `contents` vector, decoded as the members. */
export function vecSetBcs<E, Input>(element: BcsType<E, Input>) {
  return bcs.struct("VecSet", { contents: bcs.vector(element) }).transform({
    input: (members: Input[]) => ({ contents: members }),
    output: (set): E[] => set.contents,
  });
}

/** `0x2::table::Table<K, V>`: its UID and size; entries are dynamic fields of `id`. */
export const tableBcs = bcs.struct("Table", {
  id: suiObjectIdBcs,
  size: u64Bcs,
});

/** `blast_admin::delayed::Proposal<T>`: the value and the delay in force once it applies. */
export type Proposal<T> = { value: T; delay_ms: bigint; ready_at_ms: bigint };

export function proposalBcs<T, Input>(value: BcsType<T, Input>) {
  return bcs.struct("Proposal", {
    value,
    delay_ms: u64Bcs,
    ready_at_ms: u64Bcs,
  });
}

/** `blast_admin::delayed::Delayed<K, T>`: readiness never applies a value implicitly. */
export type Delayed<K, T> = {
  owner: string;
  key: K;
  value: T;
  delay_ms: bigint;
  pending: Proposal<T> | null;
};

/** Exact `blast_admin::delayed::Delayed<K, T>` field order. */
export function delayedBcs<K, KeyInput, T, Input>(
  key: BcsType<K, KeyInput>,
  value: BcsType<T, Input>,
) {
  return bcs.struct("Delayed", {
    owner: suiObjectIdBcs,
    key,
    value,
    delay_ms: u64Bcs,
    pending: bcs.option(proposalBcs(value)),
  });
}

/** `blast_admin::delayed_action::Change<A>`: an action, or a change of delay only. */
export type DelayedChange<A> =
  | { kind: "Action"; action: A }
  | { kind: "Delay" };

export function delayedChangeBcs<A, Input>(action: BcsType<A, Input>) {
  return bcs.enum("Change", { Action: action, Delay: null }).transform({
    input: (change: DelayedChange<Input>) =>
      change.kind === "Action"
        ? { Action: change.action }
        : { Delay: true as const },
    output: (change): DelayedChange<A> =>
      change.$kind === "Action"
        ? { kind: "Action", action: change.Action as A }
        : { kind: "Delay" },
  });
}

/** `blast_admin::delayed_action::DelayedAction<K, A>`: a one-shot action slot. */
export type DelayedAction<K, A> = {
  owner: string;
  key: K;
  delay_ms: bigint;
  pending: Proposal<DelayedChange<A>> | null;
};

export function delayedActionBcs<K, KeyInput, A, Input>(
  key: BcsType<K, KeyInput>,
  action: BcsType<A, Input>,
) {
  return bcs.struct("DelayedAction", {
    owner: suiObjectIdBcs,
    key,
    delay_ms: u64Bcs,
    pending: bcs.option(proposalBcs(delayedChangeBcs(action))),
  });
}

/** `blast_admin::delayed::PendingDelay`: an admission's deadline, or a proposed next delay. */
export type PendingDelay = { delay_ms: bigint; ready_at_ms: bigint };

export const pendingDelayBcs = bcs.struct("PendingDelay", {
  delay_ms: u64Bcs,
  ready_at_ms: u64Bcs,
});

/** `blast_admin::delayed_set::DelayedSet<K, E>`: admissions wait; removals are immediate. */
export type DelayedSet<K, E> = {
  owner: string;
  key: K;
  members: E[];
  delay_ms: bigint;
  admissions: { member: E; delay: PendingDelay }[];
  pending_delay: PendingDelay | null;
};

/**
 * `blast_admin::delayed::max_delay_ms`: no delayed value, action, set or map
 * accepts a longer delay, in milliseconds (30 days); one aborts with
 * `blast_admin` error 15 (`EInvalidDelay`).
 */
export const MAX_DELAY_MS = 2_592_000_000n;

/**
 * `delayed::is_guarded`: the applied delay is nonzero and no proposal would
 * set it to zero. `package_admin::unpause` requires every policy guarded.
 */
export function isDelayedGuarded(self: Delayed<unknown, unknown>): boolean {
  return self.delay_ms > 0n && (self.pending?.delay_ms ?? 1n) > 0n;
}

/** `delayed_action::is_guarded`, as `isDelayedGuarded`. */
export function isDelayedActionGuarded(
  self: DelayedAction<unknown, unknown>,
): boolean {
  return self.delay_ms > 0n && (self.pending?.delay_ms ?? 1n) > 0n;
}

/** `delayed_set::is_guarded`: also no admission scheduled earlier is pending. */
export function isDelayedSetGuarded(
  self: DelayedSet<unknown, unknown>,
): boolean {
  return (
    self.delay_ms > 0n &&
    self.admissions.length === 0 &&
    (self.pending_delay?.delay_ms ?? 1n) > 0n
  );
}

export function delayedSetBcs<K, KeyInput, E, Input>(
  key: BcsType<K, KeyInput>,
  member: BcsType<E, Input>,
) {
  return bcs
    .struct("DelayedSet", {
      owner: suiObjectIdBcs,
      key,
      members: bcs.struct("VecSet", { contents: bcs.vector(member) }),
      delay_ms: u64Bcs,
      admissions: bcs.struct("VecMap", {
        contents: bcs.vector(
          bcs.struct("Entry", { key: member, value: pendingDelayBcs }),
        ),
      }),
      pending_delay: bcs.option(pendingDelayBcs),
    })
    .transform({
      input: (set: {
        owner: string;
        key: KeyInput;
        members: Input[];
        delay_ms: bigint;
        admissions: { member: Input; delay: PendingDelay }[];
        pending_delay: PendingDelay | null;
      }) => ({
        owner: set.owner,
        key: set.key,
        members: { contents: set.members },
        delay_ms: set.delay_ms,
        admissions: {
          contents: set.admissions.map(({ member, delay }) => ({
            key: member,
            value: delay,
          })),
        },
        pending_delay: set.pending_delay,
      }),
      output: (set): DelayedSet<K, E> => ({
        owner: set.owner,
        key: set.key,
        members: set.members.contents,
        delay_ms: set.delay_ms,
        admissions: set.admissions.contents.map(({ key, value }) => ({
          member: key,
          delay: value,
        })),
        pending_delay: set.pending_delay,
      }),
    });
}

/** `blast_admin::delayed_set::SetChange<E>`: an admission, or a delay change. */
export type DelayedSetChange<E> =
  | { kind: "Admission"; member: E }
  | { kind: "Delay" };

export function delayedSetChangeBcs<E, Input>(member: BcsType<E, Input>) {
  return bcs.enum("SetChange", { Admission: member, Delay: null }).transform({
    input: (change: DelayedSetChange<Input>) =>
      change.kind === "Admission"
        ? { Admission: change.member }
        : { Delay: true as const },
    output: (change): DelayedSetChange<E> =>
      change.$kind === "Admission"
        ? { kind: "Admission", member: change.Admission as E }
        : { kind: "Delay" },
  });
}

/** `blast_admin::delayed_map::EntryProposal<V>`: a value, or null to clear, and its delay. */
export type EntryProposal<V> = { value: V | null; delay: PendingDelay };

export function entryProposalBcs<V, Input>(value: BcsType<V, Input>) {
  return bcs.struct("EntryProposal", {
    value: bcs.option(value),
    delay: pendingDelayBcs,
  });
}

/** `blast_admin::delayed_map::MapChange<E, V>`: an entry change, or a delay change. */
export type DelayedMapChange<E, V> =
  | { kind: "Entry"; entry: E; value: V | null }
  | { kind: "Delay" };

export function delayedMapChangeBcs<E, EntryInput, V, Input>(
  entry: BcsType<E, EntryInput>,
  value: BcsType<V, Input>,
) {
  return bcs
    .enum("MapChange", {
      Entry: bcs.struct("Entry", { entry, value: bcs.option(value) }),
      Delay: null,
    })
    .transform({
      input: (change: DelayedMapChange<EntryInput, Input>) =>
        change.kind === "Entry"
          ? { Entry: { entry: change.entry, value: change.value } }
          : { Delay: true as const },
      output: (change): DelayedMapChange<E, V> =>
        change.$kind === "Entry"
          ? {
              kind: "Entry",
              entry: change.Entry.entry as E,
              value: change.Entry.value as V | null,
            }
          : { kind: "Delay" },
    });
}

/**
 * `blast_admin::delayed_map::DelayedMap<K, E, V>`: applied entries in a
 * `Table` (read by dynamic field), one delay, and inline pending changes.
 */
export type DelayedMap<K, E, V> = {
  owner: string;
  key: K;
  entries: { id: string; size: bigint };
  delay_ms: bigint;
  pending: { entry: E; proposal: EntryProposal<V> }[];
  pending_delay: PendingDelay | null;
};

export function delayedMapBcs<K, KeyInput, E, EntryInput, V, Input>(
  key: BcsType<K, KeyInput>,
  entry: BcsType<E, EntryInput>,
  value: BcsType<V, Input>,
) {
  return bcs
    .struct("DelayedMap", {
      owner: suiObjectIdBcs,
      key,
      entries: tableBcs,
      delay_ms: u64Bcs,
      pending: bcs.struct("VecMap", {
        contents: bcs.vector(
          bcs.struct("Entry", { key: entry, value: entryProposalBcs(value) }),
        ),
      }),
      pending_delay: bcs.option(pendingDelayBcs),
    })
    .transform({
      input: (map: {
        owner: string;
        key: KeyInput;
        entries: { id: string; size: bigint };
        delay_ms: bigint;
        pending: {
          entry: EntryInput;
          proposal: { value: Input | null; delay: PendingDelay };
        }[];
        pending_delay: PendingDelay | null;
      }) => ({
        owner: map.owner,
        key: map.key,
        entries: map.entries,
        delay_ms: map.delay_ms,
        pending: {
          contents: map.pending.map(({ entry, proposal }) => ({
            key: entry,
            value: proposal,
          })),
        },
        pending_delay: map.pending_delay,
      }),
      output: (map): DelayedMap<K, E, V> => ({
        owner: map.owner,
        key: map.key,
        entries: map.entries,
        delay_ms: map.delay_ms,
        pending: map.pending.contents.map(({ key, value }) => ({
          entry: key,
          proposal: value as EntryProposal<V>,
        })),
        pending_delay: map.pending_delay,
      }),
    });
}

/**
 * A `DelayedSet` admission view: the admitted members, the applied delay, the
 * proposed next delay, and each scheduled admission's delay by member. Used
 * for venue, witness and claim-signer allowlists alike.
 */
export function admission<E extends string>(set: DelayedSet<unknown, E>) {
  return {
    members: [...set.members],
    delayMs: set.delay_ms,
    pendingDelay: set.pending_delay,
    pendingMembers: Object.fromEntries(
      set.admissions.map(({ member, delay }) => [member, delay]),
    ) as Readonly<Record<E, PendingDelay>>,
  };
}
