# Changelog

PlayerThree is at version 0.x: the protocol and storage formats can change between releases without compatibility
shims. The npm packages share one version, with release notes in each package's `CHANGELOG.md`
(`packages/*/CHANGELOG.md`).

## 0.1.0: initial public release

PlayerThree is a server-side SDK and protocol that adds seats AI agents can play to a multiplayer game. This release
ships:

- **`playerthree`**, the server SDK: a typed game manifest and adapter, the host (matches, teams and alliances, seat
  controllers, mandates, lobby phase and readiness, observation scope, fog-respecting observations, rate limits), the
  remote MCP seat server (MCP `2026-07-28` plus 2025-era clients, OAuth 2.1 sign-in with consent in the game),
  sandboxed JS (QuickJS) and WASM policies with deterministic `Math`, starters and portable policy packages, trusted
  first-party bot packages, typed team signals, DevTools, a player API, delayed observer streams, PostgreSQL storage,
  results, TrueSkill ratings, seed-paired series and a signed, hash-chained commander match log.
- **`@playerthree/cli`** (`playerthree`): `lint`, `audit`, `dev`, `types`, `policy build|practice|export|import` and
  `db reset`.
- **`@playerthree/runner`** (`playerthree-run`, `playerthree-mcp`): an agent runner that brings its own model key and
  budget, and a pinned MCP stdio bridge for local harnesses.
- **`@playerthree/bench`** (`playerthree-bench`): reproducible model benchmarks with authoring harnesses, private
  transcripts and billed-cost ceilings, plus deterministic bot and policy balance sweeps.
- **`@playerthree/colyseus`**: agent seats for any Colyseus room.
- **`@playerthree/connect`**: DOM-free harness setup recipes (Claude Code, the Claude API, Codex, OpenCode, Pi,
  oh-my-pi, Hermes Agent and any MCP client).
- **`@playerthree/console`**: a headless player console over the player API, with an optional drop-in panel.
- **`@playerthree/sidecar`** (`playerthree-sidecar`): a host for non-JS game servers over stdio or a local socket
  (SPEC §20.8, protocol 1), with a conformance runner and fixtures.
- **Engine SDKs** on the sidecar: Godot 4.5+ (GDScript addon), Unity / .NET (netstandard2.1 core and a Unity package)
  and Unreal / C++17 (engine-independent core and an Unreal plugin), each with a Tug of War sample.
- **The specification** (`spec/SPEC.md`), the docs and the [playerthree.gg](https://playerthree.gg) website with a
  TypeDoc API reference.
