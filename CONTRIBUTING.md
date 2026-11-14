# Contributing to PlayerThree

Thanks for helping build the game-agnostic protocol and SDK that lets LLM agents, policies and bots play games as real seats. Agent Command is the reference game.

Questions first? Ask on [Discord](https://discord.gg/JmxA65zCm5) or in GitHub Discussions. Please follow our [Code of Conduct](CODE_OF_CONDUCT.md). Security issues go through [SECURITY.md](SECURITY.md), never public issues.

## Two repositories

| Repository | What | Licence |
|---|---|---|
| [agent-command](https://github.com/agent-command/agent-command) | The game: deterministic sim, server, web client, built-in bots, maps, balance tools | AGPL-3.0-only (code); creative assets all rights reserved |
| [player-three](https://github.com/player-three-gg/player-three) (PlayerThree) | Game-agnostic protocol + SDK that lets LLM agents, policies and bots take game seats (MCP, runner, bench, console) | Apache-2.0 |

Agent Command links the SDK packages from a sibling checkout (`link:../player-three/...`), so clone both side by side with those exact directory names:

```sh
git clone https://github.com/player-three-gg/player-three.git
git clone https://github.com/agent-command/agent-command.git
(cd player-three && pnpm install --frozen-lockfile)
(cd agent-command && pnpm install --frozen-lockfile)
```

Requirements: Node.js 24+, pnpm, git. Protocol changes go **spec first** (`player-three/spec`), then the SDK, then callers in both repos. A change in PlayerThree must keep Agent Command building (`pnpm -r typecheck` in `agent-command`).

## Package names and publishing

The repository slug is `player-three`. The npm packages are `playerthree` (unscoped) and `@playerthree/bench`, `cli`, `colyseus`, `connect`, `console`, `runner` and `sidecar` (the `@playerthree` scope belongs to the `playerthree` npm organization). They share one version: Changesets releases them as one fixed group. The site (`@playerthree/site`) is private and never published.

In 0.x, storage formats change without migrations (see [AGENTS.md](AGENTS.md)). When a change needs a data reset, say so in the PR and the [changelog](CHANGELOG.md); `playerthree db reset` resets a PostgreSQL database deliberately ([CLI](docs/CLI.md#playerthree-db-reset)). No command in this repository automatically deletes data, rotates deployed secrets or renames a live checkout; npm packages are published only by the release workflow below, or by a maintainer running `pnpm release`.

### Changesets

A PR that changes what a published package does adds a changeset: run `pnpm changeset`, pick the packages, the bump (in 0.x, `minor` for a breaking change, `patch` for anything else) and a one-line summary, and commit the file it writes under `.changeset/`. `changeset version` turns changesets into the version bump and the per-package `packages/*/CHANGELOG.md` entries; do not edit those by hand. The root [CHANGELOG.md](CHANGELOG.md) summarises each release for readers of the repository: add a short, undated bullet for a notable change under its top version heading. The package changelogs are the release notes.

### What ships

Each package publishes `dist/` (built by `prepack`: `tsc -p tsconfig.build.json` plus copied assets), `README.md`, `CHANGELOG.md`, `LICENSE` and `NOTICE`, nothing else. `publishConfig` swaps the `src/*.ts` exports and bins used in the workspace for `dist/`, and pnpm rewrites `workspace:*` to the released version. `pnpm verify-pack` ([scripts/verify-pack.mjs](scripts/verify-pack.mjs), the CI `pack` job on Node 24 and 26) packs every package, checks each tarball (allowlisted files only, every source compiled or copied, exports, types and bins resolving, no `workspace:` ranges, engines, sideEffects, licence, public access, the repository URL, no checkout paths, at most 1 MiB), installs the tarballs into a fresh project outside the workspace, imports every public export, runs every bin's `--help`, typechecks a consumer against the installed types, serves the README's Tug of War example and runs the sidecar conformance runner over stdio and a socket. Run it after changing a package's exports, bins, build or runtime assets.

### How a release happens

[`.github/workflows/release.yml`](.github/workflows/release.yml) runs on every push to `main` once the repository variable `RELEASE_ENABLED` is `true` (Settings → Secrets and variables → Actions → Variables), and on demand (Actions → Release → Run workflow; the `dry_run` box is ticked by default). It typechecks and runs `pnpm verify-pack`, then:

- **Pending changesets:** it opens or updates the PR "release: version packages", which bumps the fixed version, writes the package changelogs and deletes the changesets. Review and merge it. GitHub does not run other workflows on a PR opened with the workflow token; run CI on it from the Actions tab if you want it. This needs Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests".
- **No pending changesets:** it runs `pnpm release`, which publishes every package whose current version is not on npm yet (`changeset publish`), then pushes the `<package>@<version>` git tags and GitHub releases. Versions already on npm are skipped, so a re-run is safe and an ordinary merge publishes nothing.
- **Dry run:** `pnpm release --dry-run` (`pnpm -r publish --dry-run`): it prints every tarball and the dist-tag and uploads nothing.

The dist-tag follows the version ([scripts/release.mjs](scripts/release.mjs)): a release version (`0.1.0`) goes to `latest`, a suffixed version (`0.2.0-next.0`) to `next`; in Changesets pre mode (`pnpm changeset pre enter next`, versions `x.y.z-next.N`) the pre tag applies. `pnpm release --set-version <version>` sets the fixed version in every package and its changelog heading, for a first or out-of-band version.

**The first release** is the packages' current version, `0.1.0`, on `latest`, with no changeset: there are no pending changesets, so the first release run on `main` publishes `0.1.0` with the `0.1.0` entry already in each package's changelog. 0.x already tells npm users the API is unstable, and the docs install with plain `npm i playerthree`.

### Publishing auth

The packages publish from the maintainer's personal npm account, which owns the `playerthree` organization. That account needs 2FA: npmjs.com → avatar → Account → Two-Factor Authentication → Enable 2FA (a security key or passkey, or an authenticator app), and keep the recovery codes. Optionally require it of every member: the organization → Settings → Require two-factor authentication.

**The first publish, with a token.** A trusted publisher can only be configured on a package that already exists, so the first version publishes with a granular access token from the personal account:

1. npmjs.com, signed in to the personal account: avatar → Access Tokens → Generate New Token.
2. Token name `player-three release`. Tick **Bypass two-factor authentication** (CI cannot answer a 2FA prompt). No allowed IP ranges (GitHub-hosted runners have none fixed).
3. Packages and scopes: Permissions **Read and write (publish and stage)**, not "stage only" (Changesets runs `npm publish`, not `npm stage publish`). Select packages: **All packages**. The unscoped `playerthree` does not exist yet, so it cannot be picked, and a token limited to the `@playerthree` scope could not create it.
4. Organizations: **No access** (organization access manages teams and members; it never grants publishing). Expiration: 7 days. Generate Token and copy it.
5. GitHub: Settings → Secrets and variables → Actions → New repository secret, name `NPM_TOKEN`, the token as the value.
6. Actions → Release → Run workflow on `main` with `dry_run` ticked; read the dry-run output; run it again with `dry_run` unticked.

Without a token: `npm login` with the personal account, then `pnpm verify-pack && pnpm release` from a clean `main` checkout, then `git push origin --tags`. Changesets publishes one package at a time and asks for 2FA; tick "skip 2FA for the next 5 minutes" at the first prompt.

The scoped packages land in the organization. The unscoped `playerthree` is created under the personal account; to share it, grant an organization team access (npmjs.com → the organization → Teams → the team → Packages, or `npm access grant read-write playerthree:<team> playerthree`), or add maintainers with `npm owner add <user> playerthree`. These are account-governance actions and always ask for 2FA interactively.

**Then trusted publishing (OIDC).** For each of the eight packages, once it exists: npmjs.com → the package → Settings → Trusted Publisher → GitHub Actions, then Organization or user `player-three-gg`, Repository `player-three`, Workflow filename `release.yml`, Environment name empty, and under Allowed actions tick **npm publish** (configurations default to `npm stage publish` only, which Changesets does not use). Save, confirming 2FA. The same from a terminal, signed in with `npm login` (a bypass-2FA token cannot manage trust): `npm trust github <package> --file release.yml --repo player-three-gg/player-three --allow-publish --yes`, once per package; tick "skip 2FA for 5 minutes" at the first prompt. A new configuration expires unless it completes a publish within 2 days, so configure it when a release is ready to publish (the version PR is approved), merge, and check that the publish job succeeded. Then: package → Settings → Publishing access → **Require two-factor authentication and disallow tokens** → Update Package Settings, for each package; delete the `NPM_TOKEN` secret in GitHub; revoke the token on npmjs.com (Access Tokens). The workflow file does not change: the npm CLI tries OIDC (`id-token: write`) before any token. Do not stay on the token: npm is retiring direct publishing with bypass-2FA tokens. npm's staged publishing (`npm stage publish`, approved from the Staged Packages tab) is not part of this flow, because Changesets publishes directly.

**Provenance.** npm refuses provenance attestations from a private repository, so the workflow sets `NPM_CONFIG_PROVENANCE` only when `player-three-gg/player-three` is public (a fork or mirror may be private); trusted publishing from a public repository attests every publish anyway.

## Docs and the website

[playerthree.gg](https://playerthree.gg) renders `docs/`, `spec/SPEC.md`, `CHANGELOG.md`, the package READMEs and a TypeDoc API reference from the package sources, so keep docs plain GitHub markdown with repository-relative links and write TSDoc on exported APIs. `pnpm site:dev` serves it locally; `pnpm site:build` builds it into `site/dist` and fails on any broken internal link or anchor. Pushes to `main` deploy it (`.github/workflows/pages.yml`).

Every code fence needs a language Shiki loads in `site/plugins/code.ts` (`sh`, `ts`, `json`, `gdscript`, `csharp`, `cpp`, …); fence directory trees and console output as `text`. The build fails on a fence with no language or an unknown one. The site also reads a fence's meta, which GitHub ignores: `title="path/to/file"` adds a filename header, and adjacent fences with `tab="pnpm"`, `tab="npm"` (or `tab="GDScript"`, `tab="C#"`) render as one tabbed group. Inside a block, `// [!code highlight]`, `// [!code ++]` and `// [!code --]` mark lines. GitHub alerts (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`) render as callouts.

## Branches and pull requests

- `main` is the integration branch; open PRs against it.
- Work on a topic branch, ideally in its own worktree: `git worktree add ../p3-<name> -b <name> main`.
- Merge (or rebase onto) the latest `main` before asking for review.
- Keep PRs focused. Describe the behaviour change, how you verified it and anything the maintainer must do (e.g. a deliberate data reset).
- Version 0.x: **no backward compatibility.** No shims, aliases, deprecated paths or migrations; change formats outright and update every caller.
- Read [AGENTS.md](AGENTS.md): it holds the product, code and workflow rules for humans and coding agents alike. AI-assisted PRs are welcome; you are responsible for every line and its sign-off.

## Tests: proportional verification

Check what you changed, not everything, and say exactly what you ran in the PR.

- Always: `pnpm -r typecheck` plus the affected package's tests, e.g. `pnpm --filter playerthree exec vitest run --maxWorkers=1 <files>`.
- Cross-package or protocol changes: the full sequential suite `pnpm -r --workspace-concurrency=1 test`, on an otherwise idle machine (policy CPU-budget tests are timing-sensitive).
- Then keep Agent Command green: in `../agent-command` run `pnpm -r typecheck`, and if the agent-facing surface changed, `pnpm bench:pin` there and commit `bench/surface.ts` (that game's mirrors/determinism suites, `test:mirrors`, are the reference check for sim-affecting protocol changes).
- Use `--maxWorkers=1` for vitest on shared or small machines.
- Security boundaries are absolute: seat tokens are per seat and match, projections filter every outbound message, and provider keys never reach the game server. Changes near these need tests.
- Never weaken a threshold, budget or assertion to make a test pass.

## Commit style

Short, lower-case, scope-first subjects that say what changed and why, e.g.

```
fix(host): probe policies with configured match options
observers: team observer keyframes keep every snapshot member; regression test
```

Scopes follow the package or area (`spec`, `playerthree`, `host`, `mcp`, `connect`, `runner`, `bench`, `cli`, `console`, `site`, `docs`, …). Keep unrelated changes in separate commits. Never commit secrets, `.env` files, `*:Zone.Identifier` files or generation tooling (`git add -A -- . ':!*Zone.Identifier'`).

## Sign your commits (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/) instead of a CLA. Every commit must carry a sign-off line certifying that you wrote the change or otherwise have the right to submit it under the project licence:

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it for you. Forgot? `git commit --amend -s` (last commit) or `git rebase --signoff main` (whole branch). Use your real name and an email you can be reached at.

By signing off you agree that your contribution is licensed under the Apache License 2.0.
