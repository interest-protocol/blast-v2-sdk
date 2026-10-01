# Launch economics derivation

The SDK derives explanatory economics from contract facts. It does not create a
second source of truth for launch execution.

## Responsibility split

The contract owns:

- immutable `virtual_quote` and creator-selected `graduation_target`
  snapshots;
- the immutable allocation plan and its apportionment of the Meme supply at
  finalization and of terminal Quote at migration;
- exact conservation and lifecycle enforcement; and
- the terminal-buy cap and atomic migration.

The SDK owns:

- launch previews;
- derived Meme release and terminal remainder;
- implied opening, curve-terminal, and DEX-opening valuations; and
- human-readable SUI display conversions.

The SDK result is informative. Contract balances and events remain authoritative.

## Formulas

All inputs are integer atomic units:

```text
S = atomic Meme supply (one billion whole tokens at the Meme's decimals)
V = virtual Quote reserve
T = graduation target (real Quote reserve when trading closes)
C = apportion_meme(plan, S).curve
L = apportion_meme(plan, S).lp
N = apportion_quote(plan, T).lp

R = ceil(C * V / (V + T))
B = C - R

opening valuation        = floor(S * V       / C)
curve terminal valuation = floor(S * (V + T) / R)
DEX opening valuation    = floor(S * N       / L)
```

`R` is terminal curve Meme, `B` is Meme released by the curve, `N` is Quote
handed to the destination pool, and `T - N` is Blast's one-time Quote fee plus
the Quote paid to the plan's recipients. `plan` is the complete plan with
Blast's shares set (`protocol_meme_bps`, `protocol_quote_bps`). Apportionment
gives Blast its ceiling, every other part its floor, and the residue one atom
each by descending remainder, earlier parts first on ties (curve, pool, then
recipients in plan order); `allocation.ts` mirrors it exactly. At migration
Blast's Meme and Quote shares join the launch's protocol fee ledger
(`ProtocolFeesAccrued`) rather than a payout.

The SUI creation fee paid at `launch::finalize` is held with Blast's fees on
the launch and does not enter the curve, so it changes none of these figures.

For a Meme/SUI launch, Quote values are MIST. UI formatting divides by SUI's
decimal scale; no USD price or oracle is involved.

## Execution note

The launch caps the final buy so the real Quote reserve equals `T` exactly, and
finalization rejects a target whose liquidity Quote share rounds to zero. The
DEX figure is best effort: the venue may return part of the handoff as a
residual, which the LP vault keeps for the protocol.
