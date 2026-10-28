# @interest-protocol/blast-deployments-sdk

The deployments package in the [Blast SDK monorepo](https://github.com/interest-protocol/blast-v2-sdk).

```sh
npm install @interest-protocol/blast-deployments-sdk
```

See the repository README and docs for usage, development, and release guidance.

`MAINNET_*_DEPLOYMENT` exports bind the canonical MVR publication.
`resolveMainnetDeployments(client)` resolves the five reviewed
`@blastpackages/{admin,partners,launchpad,migrators,presale}/1` packages through
the Sui client's cached MVR API and returns call-ready `admin`, `partners`,
`launchpad`, `migrators` and `presale` deployments. The compatible
`@interest-protocol/blast-sdk/deployments` export exposes the same API.

The resolver requires a mainnet client, rejects absent or foreign package
identities, and retains verified shared object IDs and original type identities.
Version pins prevent a native upgrade from being selected before Blast activates
and reviews it. MVR resolution does not enable product signing or venue routes.
