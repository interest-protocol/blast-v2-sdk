# Launch economics derivation

The SDK derives explanatory economics from contract facts. It does not create a
second source of truth for launch execution.

## Responsibility split

The contract owns:

- the creator-selected `virtual_quote` and `graduation_target`, fixed at
  finalization (contracts ADR 0092);
- the immutable allocation plan and its apportionment of the Meme supply at
  finalization and of terminal Quote at migration;
- exact conservation and lifecycle enforcement;
- the optional opening round's single pot purchase and pro-rata delivery
  (ADR 0093); and
- the terminal-buy cap and atomic migration, which accrues Blast's one-time
  Meme and Quote fee in the launch's fee ledger (ADR 0098).

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
handed to the destination pool, and `T - N` is Quote split between Blast's
one-time fee and the plan's recipients. `plan` is the complete plan with
Blast's protocol shares stored (`addProtocolAllocation`); at migration Blast's
parts accrue to the launch's protocol fees and the recipients are paid.
Apportionment gives Blast its ceiling, every other part its floor, and the
residue one atom each by descending remainder, earlier parts first on ties
(Meme: curve, pool, Blast, then recipients in plan order; Quote: pool, Blast,
then recipients); `allocation.ts` mirrors it exactly.

The virtual Quote reserve `V` is the creator's choice (`set_virtual_quote`),
not a `LaunchConfig` value. Display prices, live supply, market cap, and
progress use the formulas in `market-data.ts`, checked against blast-infra's
pinned `market-data.json` vectors.

With an opening round, settlement buys once with the whole pot at the curve's
opening price, and `previewOpeningRoundDelivery` gives a bidder
`floor(held * bid / bids)` of the held Meme and refunded Quote; the last
delivery takes the remainder. Creation also pays a SUI creation fee, held with
Blast's fees until Blast claims them; a launch's partner is paid its share of
every Blast fee in the ledger at that claim.

For a Meme/SUI launch, Quote values are MIST. UI formatting divides by SUI's
decimal scale; no USD price or oracle is involved.

## Execution note

The launch caps the final buy so the real Quote reserve equals `T` exactly, and
finalization rejects a target whose liquidity Quote share rounds to zero. The
DEX figure is best effort: the venue may return part of the handoff as a
residual, which the LP vault keeps for the protocol.
