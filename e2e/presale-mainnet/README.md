# Presale mainnet end-to-end runner

Runs the tickets in contracts `docs/presale-mainnet-e2e.md` against the
production `blast_presale` package. Successful steps are real mainnet
transactions; expected failures are simulated against live mainnet state and
must abort with the named module and error code.

```sh
node e2e/presale-mainnet/run.ts <scenario> [phase]   # e.g. setup, e010, e017 finish
node e2e/presale-mainnet/probe.ts                    # read-only venue probes
```

- The deployer signs with its key from the local Sui keystore and holds the
  presale `AdminCap`.
- Run wallets are generated into `.wallets.json` (git-ignored) and funded by
  `run.ts setup`; `run.ts setup topup` refills the creator and relayer.
- `state.json` keeps registered sale tokens and created sales, so scenarios
  that reuse a vault (e020, e022) and resumed phases find them.
- Raw per-run evidence goes to `runs/` (git-ignored). The summary is contracts
  `deployments/sui/mainnet/2026-10-04-blast-presale-e2e.json`.
- `E2E_BUDGET_MIST` caps gas per run (default 9 SUI).
