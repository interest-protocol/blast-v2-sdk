# Blast SDK

`@interest-protocol/blast-sdk` is the compatibility package in the
[Blast SDK monorepo](https://github.com/interest-protocol/blast-v2-sdk).
It re-exports the product SDKs without duplicating their implementations.

```sh
npm install @interest-protocol/blast-sdk @mysten/sui @mysten/move-bytecode-template
```

Existing imports remain supported:

```ts
import { PresaleClient } from "@interest-protocol/blast-sdk";
import { PresaleCalls } from "@interest-protocol/blast-sdk/presale";
import { blastLaunchpad } from "@interest-protocol/blast-sdk/launchpad";
```

The root export and the `/admin`, `/blast-sui`, `/boosts`, `/cctp`, `/coin`,
`/deployments`, `/holder-rewards`, `/launchpad`, `/launchpad/template`,
`/migrators`, `/partners`, `/presale`, and `/package.json` paths are preserved.
The migrators entry point also retains the Cetus and Bluefin venue readers.
The ESM package includes TypeScript declarations and supports synchronous
`require()` on Node 22.12+.

New consumers can install a product SDK directly:

```ts
import { PresaleClient } from "@interest-protocol/blast-presale-sdk";
```

See the [repository README](https://github.com/interest-protocol/blast-v2-sdk#readme)
for package selection, usage examples, deployment identities, and release guidance.
Contract state and completed events remain authoritative; previews use exact
`bigint` arithmetic. Consumers provide transport, signing, and durable storage.
