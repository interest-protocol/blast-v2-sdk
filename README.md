# Blast SDK

The launchpad SDK lives in `src/launchpad/`. It mirrors the completed Sui
launch ABI without becoming a second source of truth for protocol execution.

It provides:

- exact `bigint` buy, sell, release, fee, and valuation previews;
- BCS decoding for live `Launch<Meme, Quote>` objects through the transport-
  neutral Sui Core API;
- executable transactions for launch creation, trades, creator claims, and fee
  claims; and
- composable Move-call helpers for adapter-owned migration transactions.

## Client extension

```ts
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { blastLaunchpad } from "@blast-fun/sdk/launchpad";

const client = new SuiGrpcClient({
  network: "testnet",
  baseUrl: "https://fullnode.testnet.sui.io:443",
}).$extend(
  blastLaunchpad({
    packageId: "0x...",
    originalPackageId: "0x...",
    packageVersion: {
      objectId: "0x...",
      initialSharedVersion: "...",
      mutable: false,
    },
    launchConfig: {
      objectId: "0x...",
      initialSharedVersion: "...",
      mutable: false,
    },
    runtimeConfig: {
      objectId: "0x...",
      initialSharedVersion: "...",
      mutable: false,
    },
    protocolAuthority: {
      objectId: "0x...",
      initialSharedVersion: "...",
      mutable: false,
    },
  }),
);

const launch = await client.blastLaunchpad.getLaunch("0x...");
const preview = await client.blastLaunchpad.previewBuy(
  launch.objectId,
  1_000_000_000n,
);

const transaction = client.blastLaunchpad.tx.buy({
  memeType: launch.memeType,
  quoteType: launch.quoteType,
  launch,
  quoteAmount: 1_000_000_000n,
  minMemeOut: preview.memeOutNet,
  recipient: "0x...",
});
```

Every shared-object input is a fully qualified reference with `objectId`,
`initialSharedVersion`, and `mutable`. The SDK validates the expected
mutability for each Move argument. `getLaunch` returns these fields, so its
result can be passed directly as the `launch` transaction input.

## Deployments

`@blast-fun/sdk/deployments` is the single TypeScript registry for Blast
package lineage and singleton shared-object identities. Package entries keep
both the current and original package IDs. Shared-object entries keep the
object ID and initial shared version. Builders add `mutable` from the Move
function signature because mutability belongs to a transaction argument, not
to the object itself.

After a canonical network release is registered, initialize the client without
copying addresses into the application:

```ts
import {
  getBlastDeployment,
  launchpadDeployment,
} from "@blast-fun/sdk/deployments";

const blast = getBlastDeployment("testnet");
const extension = blastLaunchpad(launchpadDeployment(blast));
```

For local or unreleased deployments, validate one manifest with
`defineBlastDeployment`, then pass it through `launchpadDeployment`. The
built-in registry remains empty until publish output supplies real IDs; the SDK
does not ship placeholder addresses.

## Generated Meme package

`publishMeme` uses the reviewed, compiled Move template. It patches the type
identifiers, metadata, creator identity, launch policy, and deployed Blast
package dependency. The creator can be the publisher, another Sui address, or
an X identity. The transaction publishes the module and immediately makes the
package immutable. Its initializer calls `blast_fun::launch_ticket::new`, so the
publisher receives the resulting launch ticket for the next launch transaction.

```ts
const transaction = client.blastLaunchpad.tx.publishMeme({
  symbol: "DOG",
  name: "Dog Coin",
  description: "A good dog",
  iconUrl: "https://example.com/dog.png",
  burnable: false,
  sellBurnBps: 0n,
  creatorIdentity: { kind: "address", address: "0x..." },
});
```

For an X creator, pass its 32-byte identity hash instead:

```ts
creatorIdentity: { kind: "x", xIdentityHash },
```

Browser builds initialize `@mysten/move-bytecode-template` automatically. If a
bundler cannot locate its WASM asset, call `initializeMemeTemplate` once with
the asset URL before building the transaction.

For lower-level composition, import `buildMemePackageBytecode` from
`@blast-fun/sdk/launchpad/template`. Pass the original Blast package ID as its
second argument; `publishMeme` handles this from the deployment registry.

After publication completes, pass the created ticket ID to `tx.createLaunch`.
This separation is required because a Move initializer transfers the ticket; it
cannot return the ticket to another command in the publish transaction.

`tx` methods return complete transactions that route all returned coins or
capabilities. `call` methods return transaction thunks for programmable
composition. Migration remains under `call` because an approved adapter must
consume the typed payload and returned balances in the same transaction.

All protocol amounts use atomic units. Fee obligations round up to their
recipient. Curve outputs and valuations round down, so the integer remainder
stays with the reserve named by the contract formula. Contract objects and
completed events remain authoritative if transaction history changes after a
preview.

## Checks

Use Node 22.18 or newer:

```bash
npm install
npm run typecheck
npm test
```

See [docs/launch-economics.md](docs/launch-economics.md) for the endpoint and
valuation formulas.
