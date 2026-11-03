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

export const moveTypeNameBcs = bcs
  .struct("TypeName", { name: asciiStringBcs })
  .transform({
    input: (value: string) => ({
      name: { bytes: Array.from(new TextEncoder().encode(value)) },
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

/** `blast_admin::delayed::Proposal<T>`: the value and the notice in force once it applies. */
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

/** `blast_admin::delayed_action::Change<A>`: an action, or a change of notice only. */
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

/** `blast_admin::delayed::Notice`: an admission's deadline, or a proposed next notice. */
export type Notice = { delay_ms: bigint; ready_at_ms: bigint };

export const noticeBcs = bcs.struct("Notice", {
  delay_ms: u64Bcs,
  ready_at_ms: u64Bcs,
});

/** `blast_admin::delayed_set::DelayedSet<K, E>`: admissions wait; removals are immediate. */
export type DelayedSet<K, E> = {
  owner: string;
  key: K;
  members: E[];
  delay_ms: bigint;
  admissions: { member: E; notice: Notice }[];
  pending_delay: Notice | null;
};

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
          bcs.struct("Entry", { key: member, value: noticeBcs }),
        ),
      }),
      pending_delay: bcs.option(noticeBcs),
    })
    .transform({
      input: (set: {
        owner: string;
        key: KeyInput;
        members: Input[];
        delay_ms: bigint;
        admissions: { member: Input; notice: Notice }[];
        pending_delay: Notice | null;
      }) => ({
        owner: set.owner,
        key: set.key,
        members: { contents: set.members },
        delay_ms: set.delay_ms,
        admissions: {
          contents: set.admissions.map(({ member, notice }) => ({
            key: member,
            value: notice,
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
          notice: value,
        })),
        pending_delay: set.pending_delay,
      }),
    });
}

/** `blast_admin::delayed_set::SetChange<E>`: an admission, or a notice change. */
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

/** `blast_admin::delayed_map::EntryProposal<V>`: a value, or null to clear, and its notice. */
export type EntryProposal<V> = { value: V | null; notice: Notice };

export function entryProposalBcs<V, Input>(value: BcsType<V, Input>) {
  return bcs.struct("EntryProposal", {
    value: bcs.option(value),
    notice: noticeBcs,
  });
}

/** `blast_admin::delayed_map::MapChange<E, V>`: an entry change, or a notice change. */
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
 * `Table` (read by dynamic field), one notice, and inline pending changes.
 */
export type DelayedMap<K, E, V> = {
  owner: string;
  key: K;
  entries: { id: string; size: bigint };
  delay_ms: bigint;
  pending: { entry: E; proposal: EntryProposal<V> }[];
  pending_delay: Notice | null;
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
      entries: bcs.struct("Table", { id: suiObjectIdBcs, size: u64Bcs }),
      delay_ms: u64Bcs,
      pending: bcs.struct("VecMap", {
        contents: bcs.vector(
          bcs.struct("Entry", { key: entry, value: entryProposalBcs(value) }),
        ),
      }),
      pending_delay: bcs.option(noticeBcs),
    })
    .transform({
      input: (map: {
        owner: string;
        key: KeyInput;
        entries: { id: string; size: bigint };
        delay_ms: bigint;
        pending: {
          entry: EntryInput;
          proposal: { value: Input | null; notice: Notice };
        }[];
        pending_delay: Notice | null;
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

/** A product's migration witness allowlist, as both products' readers expose it. */
export function migrationAdmission(set: DelayedSet<null, string>) {
  return {
    migrationWitnessTypes: [...set.members],
    witnessDelayMs: set.delay_ms,
    pendingWitnessDelay: set.pending_delay,
    pendingWitnesses: Object.fromEntries(
      set.admissions.map(({ member, notice }) => [member, notice]),
    ) as Readonly<Record<string, Notice>>,
  };
}
