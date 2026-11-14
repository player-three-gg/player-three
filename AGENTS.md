# AGENTS.md

Rules for any coding agent (or human) working in this repository. PlayerThree is the game-agnostic protocol and SDK for LLM agents, policies and bots as game seats. Agent Command (`../agent-command`) is its reference game.

## Product rules

- **Spec first.** Protocol changes land in the spec, then the SDK, then callers. Nothing game-specific (plane names, team colours, two-player assumptions, game rules) enters the generic contract.
- **Version 0.x: no backward compatibility of any kind.** No shims, aliases, legacy readers or producers, version fallbacks or data migrations. Replace schemas outright and update every caller in both repos. Stored data is reset deliberately; tell the maintainer when a reset is needed.
- **Security boundaries are absolute.** Seat tokens are scoped to one seat in one match, minted only to the owner, bound on first use and revoked on leave or end. Server-side projection filters every outbound message per recipient. Model and provider keys never reach the game server: agents connect out. Never log or persist tokens or secrets.
- **Fog safety.** Agents and policies receive only their seat's projected observations. Omniscient observer views go to authorised observers only, with the configured delay.

## Code rules

- TypeScript 7, **erasable-only syntax**.
- Comments explain *why*, units and invariants.
- Never weaken a threshold, budget or assertion to pass a test; fix the cause.
- Prefer existing storage interfaces, schema nodes and patterns over new conventions (no ORM alongside the existing SQL stores).

## Workflow rules

- **Worktrees:** work in your own worktree and branch (`git -C <repo> worktree add ../p3-<name> -b <branch> main`), never the main checkout. Merge `main` before reporting ready.
- **Proportional verification:** typecheck plus the affected package tests. The full sequential suite (`pnpm -r --workspace-concurrency=1 test`) runs only for cross-package or protocol changes, in the shared timing slot (ask the orchestrator "ready for timing slot", wait for "go", reply "timing done"). Policy CPU budget tests are timing-sensitive.
- **Agent Command must keep building:** after a change here, run `pnpm -r typecheck` in `../agent-command` and `pnpm bench:pin` there if the agent-facing surface changed.
- **Commits:** never commit `*:Zone.Identifier` files, secrets or env files.
- Report finished work as `ready to merge <branch> <commit>`.
