# Domain Docs

Use the single-context domain documentation layout for this repository.

## Before exploring

- Read `CONTEXT.md` at the repository root when it exists.
- Read relevant ADRs under `docs/adr/` when they exist.
- If these files do not exist, proceed silently. The domain-modeling workflow
  creates them only when a term or decision must be recorded.

## Layout

```text
/
├── CONTEXT.md
├── docs/
│   └── adr/
└── packages/
    └── <sdk>/
        └── src/
```

Use glossary terms consistently in issues, specifications, tests, and code.
Surface conflicts with an existing ADR instead of silently overriding it.
