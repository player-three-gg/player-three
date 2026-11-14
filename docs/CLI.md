# `playerthree` CLI

Install `@playerthree/cli` for the `playerthree` bin (`npm i -D @playerthree/cli`, then `npx playerthree <command>`), or run `npx --package @playerthree/cli playerthree <command>`. From a checkout, after `pnpm install` at the repo root, use `node packages/cli/bin/playerthree.ts <command>` (likewise `node packages/runner/bin/playerthree-run.ts`, `node packages/runner/bin/playerthree-mcp.ts` and `node packages/bench/bin/playerthree-bench.ts`), for example `node packages/cli/bin/playerthree.ts lint packages/playerthree/examples/tag/index.ts`. `<module>` is a file exporting a `GameDefinition` named `definition` (`--export <name>` to change). Programmatic API: `@playerthree/cli`.

Exit codes: 0 on success; 1 on lint errors, audit failures, a refused or mismatched reset, runtime errors, an unknown command, or no command (the usage is printed); 2 on usage errors (unknown or malformed flags, missing arguments). `playerthree help` (`-h`, `--help`) prints the usage and exits 0.

## `playerthree lint <module>`

Flags: `--every <s>` (polling cadence in seconds, default 10), `--price model=usdPerMtok` (repeatable; adds to or overrides the built-in table), `--ticks <n>` (ticks of bot-vs-bot play to sample, default 600), `--seed <n>` (default 1), `--warn-tokens <n>` (default 8000) and `--max-tokens <n>` (default 64000) worst-case token thresholds, `--json`.

- **Worst-case observation** bytes and estimated tokens, computed analytically from the schema: full arrays, every optional present, longest literal/id, number widths, up to six JSON escape bytes per bounded-string Unicode code point, and tight endpoint-width accounting for `t.ints`. Strings use conservative token bounds, not prose compression.
- **Typical size**: a fresh match played bot-vs-bot (strongest opponent); `observe()` sampled once per game second per seat. Samples are also validated against `manifest.observation`.
- **$/hour** for an agent reading one observation every N seconds (input tokens only), over a built-in table of list prices.
- Token counts use a BPE-shaped heuristic; on tag observations it was within ~1–3% of `o200k_base`.
- Findings: missing game/role/intent docs (error), undocumented params, prose-looking enum literals, arrays (including `t.ints`) > 256 (warn) / > 4096 (error), nested list blow-up, bounded-string provenance review, missing skills or example policies, `event` without `tick`/`kind`, oversized observations. Exit 1 on errors.

## `playerthree audit <module>` · `playerthree audit --url <mcp> --token <seat token>`

Reads the seat's surface the way an agent does (core briefing, the `modes` topic's machine-readable line and the `schema/<name>` topics) and fuzzes every intent from those JSON Schemas — valid, boundary (min/max, full lists), and invalid (out of range, NaN/±Infinity, wrong types, unknown fields, huge strings, own `__proto__`/`constructor`/`prototype` keys, 2000-deep nesting, unknown/prose kinds) — and malformed arguments to every control method (path traversal and bad offsets in `game_skill`, unknown topics/pages in `game_briefing`, bad `include`, bad `wait`/`practice`/`policy_*` shapes). Paged `game_observe` results are reassembled before the schema check. Checks:

| check | |
|---|---|
| surface | briefing stable, `surfaceHash` matches `surfaceHash(manifest)` (module), or `--expect-hash` / the hash pinned when the remote audit connected |
| valid_accepted / invalid_rejected | never reject valid input; always reject invalid input with `invalid` |
| error_codes / deterministic | expected `schemaCode` and `path`, identical on repeat |
| role_check, rate_limit | `forbidden_role`; bursts beyond the advertised limit are limited |
| no_echo | no response (or raw MCP wire text) contains any input canary |
| vocabulary | every key/string is declared vocabulary or an id, except own policy text and values at their explicit bounded-string schema paths; patterns never globally exempt bounded text |
| methods, observation_schema | closed error codes; observations conform, including string code-point length/pattern and integer-array item/count bounds |
| controller_check, token_scope, outbound_guard, prototype | in-process only: human-controlled seats reject agents; forged/owner/spectator tokens rejected as seat tokens, seat tokens cannot change controllers/mint/act for other seats; a game poisoned with unknown keys or schema-invalid strings fails closed; `Object.prototype` untouched |

In-process audits lift intent rate limits on a separate fuzzing host (the real host is used for the surface, rate-limit, controller and token checks). Remote audits back off on `rate_limited`. Writes the Safety Card to `SAFETY.md` in the working directory (`--out <file>`; `--out -` skips it). `--json` prints the report as JSON instead of text; `--seed <n>` (default 1) seeds the generated cases and in-process matches; `--expect-hash <sha256>` pins a remote endpoint's surface. Exit 1 on any failure. `auditSeats()` audits any custom binding.

### Reading and publishing the Safety Card

The guarantee is **no third-party text**, not “no chat”. In opt-in chat mode, the authenticated owner may message
their own agent and receive `game_say` replies. Those messages are labelled `from: 'owner'`, kept outside game
observations, and never delivered to policies, replays or other owners. Static developer docs and the agent's own
policy logs/errors are the other permitted text sources. A card should distinguish supported tools from the
seat's current scopes and supervised approval requirements.

Sandbox wording must distinguish live capabilities from deterministic substitutes: no files/network or live
clock/entropy, but JavaScript policies have seeded deterministic `Math.random()` (sfc32), `Date.now() === 0`,
and zero-argument `new Date()` frozen at the Unix epoch; explicit date arguments still work. Game data uses
closed developer-declared labels/typed IDs and explicitly bounded trusted strings, never third-party player text.
Bounds and patterns do not establish text provenance; integration authors must enforce it. The generated Safety Card states these promises
and the own-owner chat exception; the [version 1 specification](../spec/SPEC.md#17-conformance-and-safety-card--implemented)
defines the guarantee. Audit success covers exercised checks, not proof of correct fog, fairness or determinism.

## `playerthree dev <module>`

PlayerThreeHost + MCP (`/mcp`) + DevTools operator console (`/playerthree/devtools`, local mode: loopback, no credential) on `127.0.0.1:8787` (`--port`, `--host`; `--port 0` picks a free port). One match (`--seed <n>`, default 1): your agent on `--seat team/role` (default first/first), built-in bots everywhere else. Prints the console link to the match (`http://127.0.0.1:8787/playerthree/devtools#sessions/<match id>`) and the `claude mcp add` / `npx --package @playerthree/runner playerthree-mcp` commands (from a checkout, use `node packages/runner/bin/playerthree-mcp.ts` for the latter). The clock starts on the agent's first observe/act (`--now` to start immediately). The server stays up after the match ends; Ctrl-C stops it.

## Policy authoring: `types`, `policy build`, `policy practice`, `policy export`/`import`

The same functions the host uses ([SPEC §11, §13, §17](../spec/SPEC.md#17-conformance-and-safety-card--implemented)), with no server:

**1. Generate types.** `types` writes the declarations a policy checks against.

```sh
# Observation, Intent, MatchData, Think, Init, log
playerthree types game.ts --out policy.d.ts
# Intent narrowed to one role
playerthree types game.ts --role surface --out surface.d.ts
# bound notes only, as the types topics serve it
playerthree types game.ts --brief
```

**2. Build and practice.** `policy build` bundles a source file; `policy practice` runs it in a local match.

```sh
playerthree policy build src/policy.ts --game game.ts --out policy.js
playerthree policy practice game.ts policy.js \
  --seat nw/surface \
  --teams nw,se \
  --opponent novice \
  --ticks 2400
playerthree policy practice game.ts starter.js \
  --include my-skill/policies/lib/common.js \
  --json
# one of the game's starters (spec §11 Starters), as policy_deploy {from, knobs} builds it
playerthree policy build --from my-skill/policies/starter.js --knobs '{"aggression":7}' --game game.ts --out starter.js
playerthree policy practice game.ts --from my-skill/policies/starter.js --knobs '{"aggression":7}' --seat nw/surface
```

**3. Export and import.** These move one commander version between a store and a JSON file.

```sh
playerthree policy export game.ts \
  --store ./data/commanders \
  --owner <owner> \
  --commander <id> \
  --version 3 \
  --out v3.json
playerthree policy import game.ts v3.json \
  --store ./data/commanders \
  --owner <owner> \
  --commander <id>
```

- **`types`** writes the generated declarations (stdout without `--out`). In a classic policy:
  `// @ts-check`, `/// <reference path="./policy.d.ts" />`, then `/** @type {Think} */ function think(obs) { … }`
  and `/** @type {Detail} */ var detail = ['…'];`. TypeScript modules use the same global types. Agents get the same
  text from `game_briefing {topic:"types"}` (or `types/<role>`).
- **`policy build`** bundles an ES-module or TypeScript entry (and the relative imports under its directory) into one
  classic script with the entry's `think`/`init`/`detail` exports as globals. Imports must be relative with an
  extension; `--include` composes served skill files before the bundle; `--game` checks the composed size against the
  game's `maxArtifactBytes` and makes `<skill>/<path>.js` skill imports resolvable. Exit 1 on any build error.
  With `--from <skill>/<path>.js` (and `--game`) it builds one of the game's starters instead, exactly as
  `policy_deploy {from, knobs}` does: `--knobs` is the JSON knobs object, `--role` the seat role the starter must play
  (default: its first). A rejected reference prints its closed `schemaCode`, `path` and `expected` and exits 1.
- **`policy practice`** runs `practice_run` locally (all manifest teams unless `--teams`, match options from `--options`
  JSON, the default mandate, seed 1 unless `--seed`;
  defaults: first team and role, the strongest opponent, the game's `maxTicks`). `.ts`/`.mts`/`.mjs` files (or `.js`
  with `import`/`export`) are built first; `--from <skill>/<path>.js [--knobs <json>]` practices a starter reference
  instead of a file. Prints the outcome, policy stats (including the last invalid intent with its
  path and expected type), the policy's own log lines and the report; `--json` prints the exact `PracticeResult`.
  Exit 0 only for `ok:true`.
- **`policy export` / `policy import`** read or extend a commander library in a JSON commander store (stop the server
  using it first) as a `playerthree.policy/1` package ([SPEC §13.1](../spec/SPEC.md#131-policy-packages--implemented-registries-proposed)).

## `playerthree db reset`

Resets a PostgreSQL database used by `playerthree/postgres` to the current schema. You need it when a 0.x
schema was replaced in place: `openPostgresStorage` then refuses to boot with `obsolete schema; explicit operator
reset required`, and no conversion exists. **It deletes all PlayerThree data** (commanders, the commander
match log, sign-ins, pool, history, series, publications) and the data of every game scope you name.

```sh
DATABASE_URL=postgres://… playerthree db reset \
  [--migrations <scope>=<dir>]... \
  --yes \
  [--confirm <database>]
```

- The connection string comes from `DATABASE_URL` only; it is never printed. There is no URL flag.
- `--migrations <scope>=<dir>` (repeatable) names each game's migration set, exactly as passed to
  `openPostgresStorage({migrations:{scope, dir}})`. A scope recorded in the ledger but not given is a mismatch.
- It connects, then prints the server host, database and schema, the tables it will drop and the
  `playerthree_migrations` rows it will drop. Owned tables are: every `playerthree_*` table in the current schema
  (including the ledger and tables an older schema left behind), plus the tables created by each given scope's
  **ledger-recorded** migration files. Nothing else is touched.
- Confirmation needs `--yes` **and** the database name: typed at the prompt, or given as `--confirm <database>`.
  Without a terminal (stdin and stdout), `--confirm` is required.
- The drop is one transaction under the migration advisory lock. It first re-lists the database and drops nothing if
  that differs from what was confirmed. It uses plain `DROP TABLE` (RESTRICT), so a foreign key or view from a table
  it does not own rolls the whole reset back. Then it re-applies PlayerThree's migrations and each scope's through
  `openPostgresStorage` and prints the fresh ledger.
- Exit 1, with nothing dropped, on any mismatch: no `--yes`, a wrong or missing name, a ledger scope not given, a
  recorded migration file missing from its directory, an existing table whose creating migration is unrecorded,
  a migration creating anything other than current-schema tables and indexes, or a database that changed since it
  was listed. Exit 2 on usage errors (such as a missing `DATABASE_URL`).

Stop the app's instances first (or reset while the new release is failing to boot), then restart them. On Railway,
run it locally with the Postgres service's variables. From outside Railway's private network use the public URL
that Railway's Postgres template provides:

```sh
railway run --service <postgres-service> --environment <environment> -- \
  sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" \
    exec node packages/cli/bin/playerthree.ts db reset \
    --migrations <game-scope>=<path/to/game/migrations> --yes'
```

Programmatic API: `planPostgresReset({url, migrations?})` and `resetPostgresStorage({url, migrations?, plan})` from
`playerthree/postgres/reset`, an entry separate from the storage runtime
([SPEC §21.2](../spec/SPEC.md#212-postgresql--playerthreepostgres)).

## Remote runner and stdio bridge — `@playerthree/runner`

From a checkout, run `node packages/runner/bin/playerthree-run.ts` / `node packages/runner/bin/playerthree-mcp.ts`
in place of the bin names below.

Both connect to one remote MCP endpoint with `--url <mcp>`. The credential is `--token <credential>`, else
`PLAYERTHREE_TOKEN` (keeps it out of the process list); with neither, they use browser sign-in (OAuth), cached in
`PLAYERTHREE_CONFIG_DIR` or the platform's user config directory (`playerthree/`). `--expect-hash <sha256>` refuses
an endpoint whose surface hash differs; `--no-browser` only prints the sign-in URL.

`playerthree-run --url <mcp> [--token <credential>]` plays the roles the connection commands with your own model
key (`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`) against the remote tool surface:

| flag | default | |
|---|---|---|
| `--model <id>` | `PLAYERTHREE_MODEL`, else `gpt-5-mini` with `OPENAI_API_KEY`, `claude-haiku-5-5` with `ANTHROPIC_API_KEY` | |
| `--provider openai\|anthropic` | `anthropic` for `claude*` model IDs, else `openai` | |
| `--max-usd <n>` | 1 | hard spend limit |
| `--max-output-tokens <n>` | 16384 | per model turn |
| `--max-turns <n>` | none | stop after n model turns |
| `--idle-wait <seconds>` | 30 | game seconds to wait when the model idles |
| `--price-in <usd>`, `--price-out <usd>` | built-in price | per 1M tokens; required for models without a built-in price |
| `--yes` | off | accept the endpoint's consent prompt; otherwise it is asked on the terminal, and without a terminal no consent prompt is offered |

It exits 0 when the match ends, on Ctrl-C or at `--max-turns`; 3 when it stops early (budget, provider error,
surface change); 1 when it cannot connect or the connection commands no roles; 64 on usage errors.

`playerthree-mcp --url <mcp> [--token <credential>] [--expect-hash <sha256>] [--channel]` forwards that surface and
verified skills over stdio. With browser sign-in, `--login` signs in (or checks the cached sign-in) and exits;
`--logout` forgets the cached sign-in for that URL and exits. It exits 64 on usage errors (including a malformed
`--expect-hash`), 2 on a surface hash mismatch, and 1 when the endpoint is unreachable or rejects the credential.
The bridge's optional `--channel` exposes only authenticated lifecycle wakes and explicitly labelled owner messages,
not arbitrary game text; it never grants the remote capabilities the local client did not advertise.

Local stdio `server/discover` is non-consuming: it reports only static bridge capabilities and generic
instructions to call `game_briefing` before acting. In particular, an MCP client's disposable discovery
subprocess cannot claim or burn a temporary seat. The first substantive local request (any request other than
`server/discover`, `ping` or `initialize`: a tool listing or call, a resource operation) acquires the remote
endpoint once, validates the actual hash, and loads the exact tools and verified skills. Startup diagnostics and
authentication failures are consequently deferred until that request. Modern clients must obtain the authenticated
briefing and skills before play, rather than treating generic discovery instructions as game-specific authority.
Locally the bridge serves both MCP eras. A 2025-era client (OpenCode, for one, opens stdio with `2025-11-25`) gets its
`initialize` answered by the bridge itself, negotiated per MCP (the requested revision when supported, otherwise the
latest supported one); like discovery, that handshake acquires nothing. Upstream the bridge speaks only `2026-07-28`.

Programmatic `startBridge()` accepts local traffic immediately, but its promise resolves with truthful
`tools` and `surfaceHash` only after this acquisition. Start the local client concurrently; do not wait for
that promise before sending the first substantive request.

Both clients speak only MCP `2026-07-28`: they open with `server/discover` and, when the endpoint does not offer
that revision, fail without a fallback request or a seat claim. Persistent commander tokens and OAuth stay
stateless (no session).

A temporary seat credential is bound by the first real request (the tool listing): the endpoint answers with an
`Mcp-Session-Id`, which the client then sends with the bearer on every request, including notifications, streams,
and session deletion. The first connection claims the credential; a second client cannot replay that bearer.
Clean close sends `DELETE` to revoke the lease, so reconnecting afterward requires a newly minted seat credential.
A transport error does not silently replace an already-bound seat session. These rules do not change commander or
OAuth credential lifetimes.
Closing is idempotent when the endpoint has already revoked or expired the credential, or removed the session:
DELETE's HTTP `401`/`403`/`404`/`410` is treated as already closed. Local streams always close; other HTTP,
server, and transport failures still propagate. Cleanup never reconnects or replays a bound bearer.

## Benchmark CLI — separate package

`@playerthree/bench` supplies `playerthree-bench`, not a `playerthree bench` subcommand. From a checkout, run
`node packages/bench/bin/playerthree-bench.ts` in place of `playerthree-bench` in the commands below:

```sh
node packages/bench/bin/playerthree-bench.ts \
  --config ./bench.config.ts \
  --out ./bench-results
```

Without installing: `npx --package @playerthree/bench playerthree-bench --config ./bench.config.ts`. `--out` defaults
to `./bench-results`.

The trusted local module default-exports `BenchConfig` or a nonempty array: `definition`,
an explicit `SeriesSpec` in `spec`, optional `models`, frozen `policies`, game
`resolve` hook and guardrails. Models choose `openai`, `anthropic` or offline
`scripted` (which replays its `script`), a model ID, optional `apiKeyEnv` (default
`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`), private `baseUrl`, and optional
`price: { inPerM, outPerM }` (default: the runner's price table; required when the
spec caps `maxCostUsd` and the model has no built-in price). Keys are read only by
the runner process. Ordinary series retain their shared-series budget semantics;
they are not independent authoring campaigns. Each series writes canonical
`results.json`, CSV `results.zip`, per-table CSVs in `csv/`, available
replay artifacts in `artifacts/`, `guardrails.json` when guardrails are set, and its
series store in `store/`; an array writes one `series-<n>/` directory per entry.
The command exits 1 when a series fails or does not complete, or a guardrail fails.

### Fixed-reference campaigns

```sh
playerthree-bench campaign \
  --config ./campaign.config.ts \
  --out ./campaign-data \
  [--max-campaign-usd 50]
playerthree-bench validate-publication \
  --input ./campaign-data/publication.json
playerthree-bench import-publication \
  --input ./campaign-data/publication.json \
  --store ./publications
playerthree-bench publication \
  --input ./campaign-data/campaign.json \
  --consent ./consent.json \
  --out ./publication.json
```

`campaign` requires `--config` and `--out`. It writes `campaign.json` (the private
record and attempt ledger), `publication.json`, `authoring/` (per attempt: harness,
wall time, turns, tokens, reported and billed cost, practice runs, deploy timeline,
frozen policy digests), `transcripts/`, `artifacts/`, `results/<run>/` (canonical
results and replays) and the `series/` store under `--out`. `publication` needs `--input`, `--consent` and `--out`;
`import-publication` needs `--input` and `--store` (a JSON publication store directory).

The module default-exports `CampaignConfig`: `{bench, suite, candidateId, system, consent,
build, pricing?, harness?}`.
Build the immutable suite with `createBenchmarkSuite(bench, metadata)` from
`@playerthree/bench`. Metadata supplies `id`, `version`, `title`, `track`,
`candidateId`, controlled `roles`, ordered scenario `blocks`
(`{scenarioId,blockId,stratumId}`), fixed `strata` (`{id,weight}`),
reference opponent digests, `replicates`, versioned `harness`, and `build` pins,
plus optional `bootstrapSeed` (default 1729) and `bootstrapReplicates` (default 2000).
Reference digests are `benchmarkDigest({entrant, policies: policies[id] ?? null,
gameVersion})`, with `benchmarkDigest` from `playerthree/benchmark`. The
model-independent `system.configurationDigest` identifies the
comparison profile (reasoning and allowed tools). Campaigns are common-harness:
`system.harness` must equal `suite.harness.id + '/' + suite.harness.version`.
Native or alternate harness studies require distinct, explicitly labeled suites,
not mixed primary model scores. Exact requested model/provider stays disclosed.
`executionDigest` pins private execution configuration without exporting endpoints
or keys; anonymous exports set it to `null`. It does not attest a provider's actual
weights or immutable model revision.

`harness` selects who drives authoring: omitted, the runner's own loop
(`RUNNER_HARNESS`, `playerthree-run/<version>`); or
`await openCodeHarness({bin})` from `@playerthree/bench/opencode`, which reads
`opencode --version` and names `opencode/<version>`. `suite.harness` must equal the
chosen identity. OpenCode runs `opencode run --format json` headless in a fresh home
and empty working directory under the campaign's `scratch/` (removed afterwards),
with the game's tools from `playerthree-mcp` (`game_<tool>`) and bash, web fetch, web
search, outside files and live-play tools denied. Its only provider is a loopback
proxy holding the key: it adds `model.request`, caps `max_tokens` at
`authoring.maxOutputTokens`, buffers each reply, charges it and withholds a reply
that crosses a ceiling, and records the reported upstream, generation id and cost.
A run that ends before the deadline is continued (`--session`) with the seat's
status; three runs in a row without a completed turn end authoring. OpenCode needs
an OpenAI-compatible route (`provider: "openai"` with the router's `baseUrl`).

One lobby commander commands every controlled role. `spec.authoring.starters`
(role → declared starter path) deploys those starters by reference, default knobs,
before the wall clock starts. A model with `billing: "openrouter-key"` also has its
key's billed usage (`GET <baseUrl>/v1/key`) polled during authoring; the run stops
as `budget` when that delta, or the runner estimate, reaches `maxCostUsd`.

`build` is `{game:{root,paths},runner:{root,paths}}`, with root-relative source file
or directory inputs. Compute metadata `build:{gameDigest,runnerDigest}` using
`benchmarkSourceDigest` from `@playerthree/bench/source-digest`. Execution recomputes
these hashes, including actual dirty file bytes rather than a possibly stale clean
commit claim. Include all game engine/adapter source, runner/harness source,
package manifests and dependency lockfiles; an operator must review this input
coverage. Symlinks reject; `.git`, `node_modules`, `dist` and `.cache` are excluded.
Version labels alone are not build pins.

Authored runs also require an explicit model `price` and
`pricing:{version,asOf}` describing the frozen price schedule/convention and its
ISO date. This is shared across compared models even when their rates differ.
`pricedAt` is that schedule date, not request or run start time. Private
`authoring/<run-id>-<attempt>.json` retains measured usage plus numerical rates for
audit; `campaign.json` keeps the ledger of every authoring attempt and its spend.

Authored campaigns require explicit finite per-run token, turn, cost and wall
ceilings. Each run gets fresh sessions and a budget shared only by its roles. The
per-run budget is hard: a turn whose measured usage crosses a ceiling is charged
but its tool calls never run, so the frozen artifact is the latest one deployed
within budget. `--max-campaign-usd` is a cumulative ceiling over every authoring
attempt, counting an attempt of unknown spend (a crashed process) at the full
per-run cost ceiling; no attempt starts that could cross it.
Lobby deployment probes and practice use the frozen match's participating team
subset and resolved options, never an incompatible full manifest-team roster.
Each valid latest deployed policy is frozen at the wall-clock, turn or budget
cutoff; evaluation makes no model calls.

The model's API key is checked before any authoring starts. Only model-caused
failures score zero: no valid artifact within the ceilings, or a non-transient
provider rejection after at least one completed turn. Infrastructure failures
(setup exceptions, any provider failure before the first completed turn, 408/429/
5xx and network errors, SIGINT/SIGTERM) leave the run pending and unscored; the
invocation stops, and re-running the command re-authors it with a fresh budget, at
most `1 + execution.maxInfraRetries` attempts per run. SIGINT/SIGTERM during
evaluation closes the series runner without aborting the series: the interrupted
match becomes an `infra_error` attempt of the same trial, and re-running the
command resumes the recorded series and frozen artifacts. A changed immutable
config rejects. While an earlier run can never complete (authoring attempts or
evaluation retries exhausted), no further runs are authored. The command exits
nonzero whenever the campaign is incomplete. Uploaded artifacts use
`submitted-policy` with exactly one run; their authorship is unverified. Both paths
use the same `SeriesRunner`. This coordinator
supports at most 200 trials per run (the default scheduler limit), 100 runs, and
20 million bootstrap replicate × run × trial operations; oversize imports reject
before schedule expansion. Restart after a crash recovers an active interrupted
attempt after its execution lease expires. Exhausted infrastructure retries remain
incomplete: resume never grants extra attempts or creates a replacement trial.

Model-caused authoring failures score zero. Tick caps are predeclared draws;
missing/aborted evaluation remains incomplete and has no final score. The public
weighted score and crossed run/world-block bootstrap are recomputable from the
download. Mirrors stay in a shared block. One run has no authoring uncertainty
interval; small-sample intervals are not evidence of significant superiority.
Authoring cost includes model-failed calls, covers the attempt that produced each
run (infrastructure-failed attempts stay in the private ledger), is an estimate
rather than an invoice, and preserves missing/partial coverage. Evaluation compute
is not included. Compare frontier points only within the same suite/profile;
the cost basis decides frontier eligibility, not the comparison cohort.

`consent` is `{results:true, attribution:boolean, artifacts:false, research:boolean,
training:boolean, license:string}`. Publication excludes source, prompts,
transcripts, endpoints, keys and commentary. Attribution is separately redacted.
Publication JSON is immutable once imported and retained independently of expiring
series; withdrawal leaves a tombstone and cannot recall downloaded copies. The
publication id derives from the public evidence body, so a re-export of identical
evidence keeps its id and first `publishedAt`; new evidence gets a new id and time.
Importer validation checks closed schema, hashes, lineage, adjudication and
recomputed scores, **not** trusted execution or model authorship. The publishing
service assigns trust and release timing out of band. Arbitrary uploaded config
modules must never be executed on a public server. Live and decision-barrier
attestation are not implemented by this campaign protocol.

Keep suite definitions and methodology in Git; keep generated campaign state,
content-addressed frozen artifacts and publication bundles in durable storage,
not source control. Local execution uses mode-0600 atomic fsynced files; generic
publication storage offers JSON or the existing PostgreSQL query interface.
PostgreSQL fresh schema includes `playerthree_benchmark_publications`, with no
series foreign key. Existing databases from an older schema require an operator-approved
schema reset ([`playerthree db reset`](#playerthree-db-reset)), not an automatic conversion.

### Model discovery

`playerthree-bench models [--search text] [--tools] [--reasoning] [--limit 50]
[--json] [--authenticated]` reads OpenRouter metadata, not inference. `--limit` is
1–5000 (default 50); `--search` is at most 200 characters.
Anonymous GET is the default; `--authenticated` opts into `OPENROUTER_API_KEY`.
It exits 2 on invalid arguments or `--authenticated` without that key, and 1 when
the catalog is unavailable.
JSON preserves source, fetched time, currency and per-unit decimal price hints.
Discovery is neither a model whitelist nor identity attestation, and never
changes benchmark price/configuration automatically. Hints are not billed costs.
