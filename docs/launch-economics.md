# Launch economics derivation

The SDK derives explanatory economics from contract facts. It does not create a
second source of truth for launch execution.

## Responsibility split

The contract owns:

- immutable `virtual_quote` and `migration_quote_target` snapshots;
- protocol Meme graduation fee, curve inventory, and pool provision balances;
- Quote migration-fee balance partitioning;
- exact conservation and lifecycle enforcement; and
- the eventual terminal-buy cap and asset migration.

The SDK owns:

- launch previews;
- derived Meme release and terminal remainder;
- implied opening, curve-terminal, and DEX-opening valuations; and
- human-readable SUI display conversions.

The SDK result is informative. Contract balances and events remain authoritative.

## Formulas

All inputs are integer atomic units:

```text
S = initial Meme supply
C = initial curve Meme inventory
L = Meme reserved for DEX liquidity
V = virtual Quote reserve
T = real-Quote migration target
F = Quote migration-fee basis points

R = ceil(C * V / (V + T))
B = C - R
M = ceil(T * F / 10_000)
N = T - M

opening valuation        = floor(S * V       / C)
curve terminal valuation = floor(S * (V + T) / R)
DEX opening valuation    = floor(S * N       / L)
```

`R` is terminal curve Meme, `B` is Meme released by the curve, `M` is protocol
Quote revenue, and `N` is Quote available for the destination pool.

For a Meme/SUI launch, Quote values are MIST. UI formatting divides by SUI's
decimal scale; no USD price or oracle is involved.

## Important execution note

The future stateful launch contract must still cap the final net-Quote input at
`T`. Otherwise a terminal trade can overshoot and the actual balance outcome can
differ from the SDK's exact-target preview.
