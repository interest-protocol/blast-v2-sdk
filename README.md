# Blast SDK

This repository is the off-chain home for Blast V2 launch previews, transaction
builders, and contract-state decoding. It is intentionally small while the
stateful launch contract is still being designed.

The placement rule is in [AGENTS.md](AGENTS.md): contracts own
consensus-critical transitions and canonical facts; the SDK owns everything
that can be deterministically reconstructed from them.

## Launch economics

`deriveLaunchEconomics` forecasts the exact-target curve endpoint and implied
total-supply valuations from immutable contract parameters. It uses `bigint`
throughout so SUI and Meme atomic units are never converted through JavaScript
floating point.

```ts
import { deriveLaunchEconomics } from "./src/launch-economics.ts";

const outcome = deriveLaunchEconomics({
  initialMemeSupply: 1_000_000_000_000_000_000n,
  curveMemeInventory: 800_000_000_000_000_000n,
  poolMemeProvision: 200_000_000_000_000_000n,
  virtualQuote: 800_000_000_000n,
  migrationQuoteTarget: 800_000_000_000n,
  quoteMigrationFeeBps: 0n,
});
```

This is a preview function, not an additional contract rule. The contract owns
the balances, immutable curve inputs, migration threshold, and allocation
conservation. The SDK derives explanatory values from those facts.

## Generated Meme bytecode

`buildMemePackageBytecode` patches the reviewed, compiled Move module used to
create a Blast launch ticket. It replaces the module and witness identifiers,
metadata, creator identity, launch policy, and original Blast package ID. The
creator may be another Sui address or a 32-byte X identity hash.

```ts
import { buildMemePackageBytecode } from "@blast-fun/sdk/launchpad/template";

const module = await buildMemePackageBytecode(
  {
    symbol: "DOG",
    name: "Dog Coin",
    description: "A good dog",
    iconUrl: "https://blast.fun/meme.png",
    creatorIdentity: { kind: "address", address: "0x..." },
    burnable: false,
    sellBurnBps: 0n,
  },
  "0x...", // Blast's original package ID
);
```

For an X creator, pass
`{ kind: "x", xIdentityHash: Uint8Array.from(...) }`. The builder validates
that the hash contains exactly 32 bytes.

Run the current checks with Node 22.18 or newer (the test runner executes
TypeScript directly through Node's native type stripping):

```bash
npm install
npm run typecheck
npm test
```

See [docs/launch-economics.md](docs/launch-economics.md) for formulas and the
contract/SDK responsibility split.
