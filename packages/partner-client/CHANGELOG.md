# Changelog

## 0.1.0 — unreleased

- Initial standalone BLAST partner REST read client: presale list, featured
  presales, presale detail, prices, search and market status.
- Exact generated wire/query types with decimal strings, nullable values,
  unavailable states and explicit cursor pagination preserved.
- Environment-agnostic ESM using Web APIs and injected fetch; no runtime or peer
  dependencies. Keys remain inputs to server/proxy integrations.
- Fixed encoded routes, redirect rejection, no-store, bounded response bytes,
  timeout/cancellation and sanitized errors. No automatic retries or polling.
- Coming-soon launchpad reads remain unavailable. The on-chain SDK is separate.
- MIT license. Node 22.18+ is a tooling requirement; runtime support depends on
  standard Web APIs rather than a Node-specific API.
