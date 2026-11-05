import { bcs } from "@mysten/sui/bcs";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { addressBcs } from "./bcs.ts";
import { apportionBps, bpsBcs, MAX_ROUTES, requireBps } from "./bps.ts";
import { BASIS_POINTS_DENOMINATOR } from "./integers.ts";

/**
 * `blast_core::fee_split::Destination`: where one route's part of each
 * LP-fee collection goes. The vault decides what each special kind does.
 */
export type Destination =
  | { kind: "Address"; address: string }
  | { kind: "Owner" }
  | { kind: "AutoLp" }
  | { kind: "HolderRewards" }
  | { kind: "Burn" };

/** `blast_core::fee_split::Route`: one destination and its positive share. */
export type Route = { destination: Destination; bps: bigint };

/** `blast_core::fee_split::FeeSplit`: routes summing to exactly 10,000. */
export type FeeSplit = { routes: Route[] };

/** BCS of `Destination`, in Move variant order. */
export const destinationBcs = bcs
  .enum("Destination", {
    Address: addressBcs,
    Owner: null,
    AutoLp: null,
    HolderRewards: null,
    Burn: null,
  })
  .transform({
    input: (destination: Destination) =>
      destination.kind === "Address"
        ? { Address: destination.address }
        : ({ [destination.kind]: true } as
            | { Owner: true }
            | { AutoLp: true }
            | { HolderRewards: true }
            | { Burn: true }),
    output: (destination): Destination =>
      destination.$kind === "Address"
        ? { kind: "Address", address: destination.Address }
        : { kind: destination.$kind },
  });

export const routeBcs = bcs.struct("Route", {
  destination: destinationBcs,
  bps: bpsBcs,
});

export const feeSplitBcs = bcs.struct("FeeSplit", {
  routes: bcs.vector(routeBcs),
});

/**
 * Checks `split` as far as `fee_split::new` would reject it: at most 20
 * routes, each positive (and an address route nonzero), no destination
 * twice, summing to exactly 10,000. Returns the routes with normalized
 * addresses, in the given order (the order `apportion` pays them).
 */
export function normalizeFeeSplit(split: FeeSplit): FeeSplit {
  if (split.routes.length > MAX_ROUTES) {
    throw new RangeError(`a fee split holds at most ${MAX_ROUTES} routes`);
  }
  const routes = split.routes.map(({ destination, bps }): Route => {
    if (requireBps(bps) === 0n) {
      throw new RangeError("a fee-split route needs a positive share");
    }
    if (destination.kind !== "Address") return { destination, bps };
    const address = normalizeSuiAddress(destination.address);
    if (address === normalizeSuiAddress("0x0")) {
      throw new RangeError("a fee-split route cannot pay the zero address");
    }
    return { destination: { kind: "Address", address }, bps };
  });
  const keys = routes.map(({ destination }) =>
    destination.kind === "Address" ? destination.address : destination.kind,
  );
  if (new Set(keys).size !== keys.length) {
    throw new RangeError("a fee split names each destination at most once");
  }
  if (
    routes.reduce((sum, route) => sum + route.bps, 0n) !==
    BASIS_POINTS_DENOMINATOR
  ) {
    throw new RangeError("fee-split routes must sum to 10,000 basis points");
  }
  return { routes };
}

/**
 * Mirrors `fee_split::apportion`: `total` atoms split across the routes
 * exactly, in route order, by `bps::apportion` with no rounded-up part.
 */
export function apportionFeeSplit(split: FeeSplit, total: bigint): bigint[] {
  return apportionBps(
    split.routes.map(({ bps }) => bps),
    total,
    null,
  );
}
