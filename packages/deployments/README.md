# @interest-protocol/blast-deployments-sdk

The deployments package in the [Blast SDK monorepo](https://github.com/interest-protocol/blast-v2-sdk).

```sh
npm install @interest-protocol/blast-deployments-sdk
```

See the repository README and docs for usage, development, and release guidance.

A `BlastDeployment` (schema 2) names the fresh launch stack of contracts ADR
0137: `admin`, `partners`, `core`, `vesting`, `vault`, `launchpad`, `presale`
and `migrators`, with every package's `PackageVersion` and `PackageAdmin`, the
core `Treasury`, the `VaultRegistry`, `LaunchRegistry` and `PresaleRegistry`,
and optional venue sets (Cetus, Bluefin, the Aftermath DAO vendor).
`coreDeployment`, `vaultDeployment`, `migratorsDeployment`,
`launchpadDeployment` and `presaleDeployment` derive each package's call-ready
deployment from it.

`BLAST_DEPLOYMENTS` is empty until the publish script writes the mainnet
manifest; `getBlastDeployment` throws `DeploymentManifestError("unpublished")`
until then. `evaluateProtocolAccess` decides whether a manifest may sign and
reports each package's observed pause mask. `admissionRunbook` builds the
contracts' paused admission, notice raise and unpause sequence
(`deployments/README.md`, "Admission while paused").
