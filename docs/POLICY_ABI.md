# Policy ABI

A **policy** is agent-written code that maps one observation to a list of intents, at tick rate, with no LLM in the loop.
Two artifact formats are accepted (`manifest.control.policy.runtimes`):

| Runtime | Artifact | Engine |
|---|---|---|
| `js` | JavaScript source text (classic script) | QuickJS (bellard 2025-09-13) compiled to WebAssembly |
| `wasm` | A core WebAssembly module, any language | V8's WebAssembly engine |

Both follow the same lifecycle:

1. **Load** (`loadPolicy(runtime, code, limits, { seed, matchData })`): size check, compile, ABI checks, instantiate,
   run top-level code / the wasm start function, then `init(matchData)` (JS) or `init(ptr,len)` (WASM) if present.
2. **Call** (`instance.call(observation)`): the observation (the game's `manifest.observation`, already fogged and
   schema-checked) goes in as JSON; an array of intents comes out. State persists between calls of one instance (one match).
3. **Dispose**. Instances never share state.

The output is untrusted: the host validates every intent exactly like an intent from a live agent (schema, role,
controller, rate limit).

Before activation, the host probes an artifact on the actual seat's guarded current observation and bootstrap.
Any runtime error, invalid schema/role intent or exceeded intent budget rejects the activation. Only after the
probe succeeds does the host create a fresh live instance with clean state, calling `init` once again on that
new instance; the probe's globals and counters never become live state. A controller or assignment change
during validation prevents installation. Retired library/pool probes finish as explicit cancelled activation
failures, dispose their VMs, and cannot overwrite a newer assignment's readiness; direct deploy calls report
the cancellation to their awaiting caller as `forbidden`.

Saved commander library versions and pool entries retain the host-authored `surfaceHash` from deployment, beside
`artifactHash` (SHA-256 of the module bytes: the composed JS source as UTF-8, or the decoded wasm module).
Every library seating, pool activation and rollback compares the surface hash to the current surface and repeats
the seat probe. Mismatches report `stale_policy`; failed probes report `policy_failed`; neither can satisfy
readiness. A successful redeployment clears the failure. Memory, JSON and Postgres stores keep the hash with the
artifact: JSON artifact files are `<version>.json` / `<policyId>.json` holding runtime, code, surface hash and
artifact hash; PostgreSQL stores a required `surface_hash` column and derives `artifactHash` from the stored code.
A database created by an older schema refuses to open (`obsolete schema; explicit operator reset required`);
[`playerthree db reset`](CLI.md#playerthree-db-reset) drops and re-creates its tables, after which policies are
redeployed against the current host.

Commander versions have host-recorded role provenance and independent `policy.activeByRole` selections.
Deploying or rolling back one role never changes another role's selection; version numbers remain unique
within the commander and retention is bounded to ten versions per role. Library restoration always uses a
fresh VM and `policy_status` awaits its completion. Activation failure is exposed as `activationError`
(`stale_policy`, `policy_failed`, or `needs_role_deploy`), not a transient or misleading absent policy.
The store migrates old single-role records once. Old multi-role versions without role provenance are retained
as `role:null`, never guessed or automatically replayed on every role; redeploy for each intended role.
This does not change agent readiness: direct control remains valid without an installed policy.

Runtime stats distinguish `successfulCalls` from attempted `calls`, and `consecutiveFailures` from historical
`errors`/`timeouts`. Successful empty intent lists count as decisions; successful calls reset the streak.
`lastError` remains historical after recovery. Failed sandbox restarts count as failures, not successful decisions.

## Match bootstrap

Match data is a separate initialization payload, never part of `think`'s observation, including its first call.
Games declare `manifest.matchData` as a closed `t.obj` schema and implement `adapter.matchData(seat)`. The method
is required when the schema exists. The host snapshots and validates the seat-visible result with the outbound
guard before every fresh consumer, including deployment probes (lobby and match), library/pool activation,
practice, benchmarks and crash restarts.

`loadPolicy` accepts optional `opts.matchData`: a JSON-compatible value, snapshotted at load time. Its serialized
UTF-8 JSON is independently capped at **128 KiB** (`MATCH_DATA_MAX_BYTES`, exported from `playerthree`). Invalid JSON
input fails with `bad_output`; oversized input fails with `too_large`, without echoing data. Host guard failures
use the `matchData` channel and fail closed; over-bound bootstrap yields `too_long`. No observation, artifact,
output or memory limit is increased. Omission initializes with JSON `null`.

JavaScript's optional synchronous `init(matchData)` receives the parsed snapshot once per instance. WASM's
optional `init(ptr:i32,len:i32)->()` receives the UTF-8 JSON in an `alloc`-provided, checked memory region, once
after module startup. The old zero-argument WASM `init` signature is rejected. Initialization is subject to the
ordinary load budget. Policies retain what they need in their own instance state.

Built-in bots may implement synchronous `init(matchData)`; the host calls it once before their first `think`,
including fallback bots and bot-level/controller recreation. Direct game-owned bot drivers must do the same.
Agents receive the same guarded data as the `match-data` briefing topic (`game_briefing {topic:"match-data"}`), only in phase `match`; in the lobby that topic documents the fields only.
All ordinary and stream observations remain dynamic-only. The game owns bootstrap field names and fog
restrictions; there is no generic `rules` field, reconstruction, observation snapshot option or second `think` argument.

## Observation detail

Games that declare an `observationScope` (spec §3) render each observation with a *detail*: the sections shown in full,
the others as the game's compact summaries. A policy's observations use its role's default sections unless the
artifact declares the sections it reads, once, as the string `"all"` or a list of section names (the game's
`observationScope.sections`, see the core briefing's `observationScope` and topic `observation`):

- `js`: a global named `detail` — `var`, `let`, `const` or a `globalThis` property — read once after top-level code
  and before `init`. Example: `const detail = ['surface'];`
- `wasm`: one custom section named `playerthree.detail` whose bytes are the UTF-8 JSON value (e.g. `["surface"]`), read
  before the module is instantiated. Rust: `#[unsafe(link_section = "playerthree.detail")] #[used] static DETAIL: [u8; 11] = *b"[\"surface\"]";`

The host resolves the declaration when it loads the artifact (deploy probe, activation, practice and restarts):
every `think` of that instance then receives observations at the role's defaults united with the declared sections.
A declaration that is not JSON data, not `"all"` or a list of unique section-name strings, names a section the game
does not declare, or (wasm) comes in more than one section fails loading with `bad_output`. Built-in bots always see
every section. Declaring more detail costs parse time on every call: read summaries where they suffice.

## Team signals

In games declaring team signals (spec §22) every observation, the policy's included, has a host-owned
`signals: { inbox, sent }` member: typed requests teammates sent this seat and the ones it sent, with their `id`,
`from`, `to`, `tick`, `expires`, `state`, `by` (the responding role, once one answered) and payload. A policy answers with
`signal_update` intents (`ack`, `decline`, `done`, `fail`; `cancel` for its own) and asks with `signal` intents, in the
same intent array as everything else and under the same `maxIntentsPerCall`. Refusals count in `intentsRejected` as
`signal:<code>`. Nothing in a signal is text.

## Includes

A JS artifact may list `include: ["<skill>/<path>", …]` (≤ 16 distinct served skill `.js` files, e.g. a game's policy
library) on `policy_deploy` and `practice_run.artifact`. The host composes `included contents joined by "\n"`, then
`"\n"`, then `code` (exported as `composePolicy(skills, code, include?)`). Unknown, duplicate or non-`.js` entries, or
`include` with `wasm`, are `invalid`; the size limit, probe, storage, versioning, publishing and hashing all use the
composed source.

## Modules and types

Instead of `code`, a JS artifact may carry ES modules: `modules: {"<path>.js|.mjs|.ts|.mts": source, …}` and
`entry: "<path>"` (≤ 64 modules, ≤ 1 MiB of source together, paths in the skill file grammar, first segment not a
served skill name). The host bundles them with esbuild (`buildPolicy`, exported from `playerthree/policy`, also used by
`playerthree policy build`): TypeScript types are stripped without type checking, syntax is lowered to the engine's
level (`POLICY_ES_TARGET`, `es2025`), and imports must be relative with an extension, naming another module or a served
skill file as `./<skill>/<path>.js`. No filesystem, network or packages. The entry exports `think` (and optionally
`init`, `detail`); the bundle binds those exports to the ABI's globals, so the result is an ordinary classic script.
`include` still composes before the bundle. A build error is `invalid` with the esbuild `message` and a
`location {file, line, column}`; the composed script is what is size-checked, probed, stored and hashed.

Typed authoring: `playerthree types <game module>` or the `types` / `types/<role>` briefing topics give TypeScript
declarations generated from the manifest (`Observation`, `Intent` and one `<Kind>Intent` per kind, `MatchData`,
`Detail`, `Think`, `Init`, `log`). A JS policy opts in with `// @ts-check`, `/// <reference path="policy.d.ts" />` and
`/** @type {Think} */ function think(obs) { … }`. Invalid intents report what was expected in the same vocabulary:
the ack's (and `policy_status.lastInvalid`'s) `expected`, e.g. `MoveIntent["x"]: number (integer 0..63)`.

## Starters

A game may declare starters (manifest `starters`, [SPEC §11 *Starters*](../spec/SPEC.md#starters--implemented)):
ready-made baseline policies served as skill `.js` files and listed, with their roles and knobs, in the briefing topic
`starters`. Instead of `code` or `modules`, `policy_deploy` and `practice_run.artifact` take a reference:

```json
{ "from": "<skill>/<path>.js", "knobs": { "aggression": 7 } }
```

The starter module (an ES module, resolved with its relative imports like a served skill import above):

| Export | |
|---|---|
| `createPolicy(knobs)` | Required. Returns one seat's instance `{ think(obs), init?(matchData) }`, exactly as the trusted ABI's factory; `knobs` is the validated knobs object (keys in schema order, every knob optional), or `null` without `knobs`. |
| `knobs` | Optional. A plain-JSON JSON Schema: `{type:"object", additionalProperties:false, properties}`; each property has a `default`, an optional `description` and one of `integer`/`number` with `minimum` and `maximum`, `boolean`, `string` with `enum` or `maxLength` (≤ 256), `array` with `items` and `maxItems` (≤ 256), or a nested object (≤ 4 deep, ≤ 32 properties per object, ≤ 16 KiB). No `required`. Without it only `{}` is accepted. |
| `detail` | Optional. The observation detail, as for any JS policy. |

The host checks `from` against the declared starters for the seat's role and `knobs` (≤ 4096 bytes of JSON) against
the schema; a failure is `invalid` with `schemaCode`, `path` (`["from"]` or `["knobs", …]`, `?` for an unknown key) and
`expected` (`Knobs["aggression"]: number (integer 0..10)`), never echoing input. It then builds a generated entry module
with `buildPolicy`, so each sandbox instance holds one `createPolicy(knobs)` instance bound to `think`/`init`/`detail`.
The rest is an ordinary deploy: size limit, probe, versioning, publishing. The library version, `policy_status` and the
exported package (`source: {from, knobs?}`) record `from` and `knobs`. The host evaluates each starter's module graph once
at startup outside the sandbox to read its exports, so a starter's top level must be deterministic and side-effect free.
To go beyond the knobs, fork it: `modules` whose entry imports `./<skill>/<path>.js` and calls `createPolicy` itself.

Every artifact has exactly one body: `code`, (js) `modules` + `entry`, or `from`. The host names a wrong shape as
`invalid` with `schemaCode`, `path` and `expected` ([SPEC §11 *Artifact shape*](../spec/SPEC.md#11-policy-abi--implemented)):
no body is `missing_field` at `["code"]` with `expected` `Artifact: one of code | modules+entry | from` (`from` only for
games with starters); a missing `runtime` or `entry` is `missing_field` there; a second body, or a member its body does
not take (`entry` with `code`, `include` with `from`), is `unknown_field` at that member; an unknown key is
`unknown_field` at `["?"]`. Inside `practice_run` the path starts with `"artifact"`.

A library version can be exported and imported as a `playerthree.policy/1` package (sources plus the composed script,
hash-verified and rebuilt on import): see [SPEC §13.1](../spec/SPEC.md#131-policy-packages--implemented-registries-proposed).

## Isolation

- Every instance runs in its **own worker thread** with its own engine instance (one QuickJS runtime + context, or one
  wasm instance). The host talks to it over shared memory; the policy has no other channel.
- **Hard stop.** A call that overruns its budget is stopped wherever it is (tight loops, long native operations such as
  a big `Array.prototype.sort`, wasm loops): QuickJS is interrupted, and a host-side watchdog terminates the thread at
  `4 × msPerCall + 150 ms` after the request if nothing else has. A JS call the CPU-budget interrupt stopped keeps its
  instance ([Timeouts](#timeouts)); every other timeout leaves the instance `dead`.
- **No host capabilities.** No file system, network, clock, timers, environment, randomness source, module loader or host
  objects. The only way out is the return value and `log`.
- Policy stdout/stderr never reach the host's stdio.
- **Own-text rule.** The only free text a policy produces that reaches an agent is its own log lines and engine
  messages about its own artifact (compile errors, exceptions, traps) — both authored by the same principal.

## Limits

From `PolicyLimits` (the game's manifest):

| Limit | Meaning |
|---|---|
| `runtimes` | Artifact formats the game accepts; any other is `runtime_not_allowed`. |
| `hz` | Calls per second of game time: `think` runs every `max(1, round(tickRate / hz))` ticks, the cadence built-in bots use too. |
| `msPerCall` | CPU-time budget per call: CPU time of the sandbox's own thread, measured from the moment it picks the call up. Time the thread spends descheduled by the OS (a loaded machine), thread wake-up latency and host event-loop stalls never count, so whether an artifact fits its budget does not depend on machine load. The clock is the OS per-thread CPU clock (`process.threadCpuUsage()`, `getrusage(RUSAGE_THREAD)`); Linux advances it at scheduler ticks and context switches, so a reading can trail the true value by about one tick (4 ms at `HZ=250`). Separately, a wall-clock **hang guard** bounds work the thread cannot interrupt or a thread starved of CPU: `4 × msPerCall + 100 ms` on the sandbox thread. Either overrun → `timeout`: a `js` instance over its CPU budget is kept ([Timeouts](#timeouts)), otherwise the instance is dead. `PolicyCallResult.cpuMs` reports the budgeted CPU time, `PolicyCallResult.ms` the sandbox-side wall time. |
| `memoryBytes` | `js`: QuickJS heap. The engine's linear memory is capped at its fixed baseline (static data + 5 MiB native stack) + `memoryBytes`; any single allocation larger than `memoryBytes` is refused outright. Exhaustion → `memory_limit`, instance dead. `wasm`: the declared maxima of all memories together must be ≤ `floor(memoryBytes / 65536)` pages (checked at load). |
| `maxArtifactBytes` | UTF-8 bytes of JS source (the composed source when `include` is used), or bytes of the wasm module. |
| `maxIntentsPerCall` | Extra intents are dropped and counted in `PolicyCallResult.dropped`. |
| `maxLogLines` | Lines kept per call; further `log` calls in that call are ignored. |
| `maxLogLineBytes` | Each line is truncated to this many UTF-8 bytes, never splitting a character. |

Fixed by PlayerThree:

| Limit | Value |
|---|---|
| Load budget (top-level code / start function + `init`) | 10 × `msPerCall` of sandbox-thread CPU time; hang guard `4 × load budget + 100 ms` wall |
| Output size (UTF-8 JSON) | 1 MiB |
| Match bootstrap UTF-8 JSON, independently of observation input | 128 KiB |
| Output nesting depth (both runtimes, checked by the host on the parsed output) | 32 |
| Engine/exception message length | 1 KiB |
| QuickJS stack (`js`) | 256 KiB (deeper recursion throws `InternalError: stack overflow`, catchable) |
| Table entries, all tables together (`wasm`) | 65,536 |
| Host watchdog (thread terminated) | Hang guard + 50 ms from sending the request: `4 × msPerCall + 150 ms` per call, `4 × load budget + 150 ms` for load |

## Errors

`PolicyError.code` (`control.ts`):

| Code | When | Instance |
|---|---|---|
| `runtime_not_allowed` | Runtime not in `limits.runtimes` | — |
| `too_large` | Artifact over `maxArtifactBytes`, or match bootstrap JSON over 128 KiB; on a call, an observation larger than the 256 MiB call channel | — |
| `compile` | JS syntax error (message: `SyntaxError: … (policy.js:line:col)`), or source not valid UTF-8 | — |
| `bad_module` | Invalid wasm binary; 64-bit or shared memory, 64-bit table; custom page sizes; GC struct/array types | — |
| `imports_not_allowed` | Any import other than `env.log (i32, i32) -> ()` (WASI included), imported memory | — |
| `missing_export` | JS: no global `think`. wasm: missing `memory`/`alloc`/`think`, or a wrong signature | — |
| `memory_limit` | JS heap exhausted; wasm memory/table without a maximum or over budget (at load) | dead |
| `timeout` | Call or load over budget | `js` call stopped by the CPU-budget interrupt: usable, state as of the interruption ([Timeouts](#timeouts)); otherwise dead |
| `threw` | JS exception (`Name: message (policy.js:line:col)`), wasm trap (`RuntimeError: unreachable`, …) | usable* |
| `bad_output` | Not an array, not JSON, not UTF-8, out of bounds, too large, nested too deep; at load: invalid initialization JSON/region, or a malformed or unknown `detail` declaration | usable after a call; no instance on load failure |

\* An engine-level crash (e.g. native stack exhaustion inside QuickJS itself) is reported as `threw` and kills the
instance, since the engine's state can no longer be trusted. A dead instance answers every further call with the error
that killed it. Log lines written before a non-fatal failure are returned with it (`logs`); lines logged during load are
discarded.

## Timeouts

A `js` call that the in-engine CPU-budget interrupt stops fails `timeout` and returns no intents (its log lines are
returned), but the instance lives on with its state. The interrupt raises an uncatchable error that unwinds the whole
stack: no `catch` or `finally` block runs, inside async functions too (their promise rejects with
`InternalError: interrupted`, which a `.catch` handler may observe). The state is therefore whatever it was at the
interruption point: a map may be half-updated, an array half-sorted, a counter incremented with the work it counts
undone. Where that point falls depends on CPU timing, so it is not deterministic.

- **Promise jobs** still queued at the interrupt are drained before the timed-out call returns: they run to completion
  under a fresh `msPerCall` budget billed to that call, never in or to the next call. A drain that overruns as well
  kills the instance.
- A `js` call that returns over its budget without the interrupt firing (it polls between bytecodes, so one long
  native operation can finish first) fails `timeout` the same way, with its state intact.
- **Cap:** after `MAX_CONSECUTIVE_TIMEOUTS` = 3 timeouts with no successful call in between, the host kills the
  instance; any successful call resets the count.
- **Still killed:** the hang guard and host watchdog, every `wasm` overrun, a load over its budget, the trusted
  runner's guard, `memory_limit` and engine crashes.
- A killed instance is reloaded fresh (top-level code and `init` again) on its next call, at most three times with no
  successful call in between; then the policy is no longer called until the next deploy or rollback.

**Writing timeout-tolerant code.** Keep state consistent at every point an interrupt can land: compute into locals and
commit to long-lived state at the end of `think`, in a few assignments; replace a structure rather than edit it in
place when an edit takes many steps; and do not rely on `finally` to restore invariants. Spread long work, such as a
route search, over several calls with an explicit cursor that is committed only after each finished step, so an
interrupted call repeats at most one step.

```js
let plan = null; // committed state
function think(obs) {
  const next = replan(plan, obs); // may be interrupted: `plan` is untouched until the line below
  plan = next;
  return plan.intents;
}
```

## Determinism

Same artifact + same `seed` + same match data + same observation sequence ⇒ the same outputs and logs, on the same PlayerThree version.
This is what makes practice runs and replays reproducible.

- `js`: `Math.random()` is an sfc32 generator seeded from `seed` (default 0). `Date.now()` returns `0` and `new Date()` is
  the epoch; explicit dates (`new Date(ms)`, `Date.UTC`, `Date.parse`) work normally. Local-time getters follow the host's
  time zone — use the UTC getters. Promise jobs run after `think` returns, in order, inside the same budget; they cannot
  change the returned value.
- `js` `Math`: `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `sinh`, `cosh`, `tanh`, `asinh`, `acosh`, `atanh`,
  `exp`, `expm1`, `log`, `log1p`, `log2`, `log10`, `pow`, `cbrt` and `hypot` are PlayerThree's pure-JS fdlibm port, so
  results are bit-identical under QuickJS and V8; the exact functions (`sqrt`, `round`, `floor`, `abs`, `min`, …) stay
  native. The engine (`quickjs 2025-09-13`) and the Math port version are part of `surfaceHash`.
- Host-registered first-party packages (never uploads, e.g. a game's bot tiers) may instead run in V8 through the
  trusted runner (`loadTrustedPolicy`), at in-process bot speed: one realm per package shared by every seat, the
  script's global `createPolicy(options)` giving each seat its own instance (`options`: the seat's bot options, or
  `null`), the observation passed as an object, synchronous
  calls with a 1 s hang guard instead of the CPU budget. Determinism and output checks are the sandbox's, and one
  instance gives the same intents as the package's sandbox globals. Such packages should ship unminified, with a
  readable source that rebuilds to the shipped script, so built-in bots can be read, exported and forked; they must
  stay within `maxArtifactBytes`, and are minified only if the package records it so the rebuild matches
  ([SPEC §11](../spec/SPEC.md#trusted-runner--implemented)).
- `wasm`: the module receives no entropy source and no clock. Remaining nondeterminism is what the WebAssembly spec
  leaves to the engine: NaN bit patterns and relaxed-SIMD results — avoid depending on them.

## JavaScript ABI

The artifact is a **classic script** (no `import`/`export`; module syntax is a `compile` error, and `import()` always
rejects). Everything is a global:

```text
function think(obs) -> intent[]   required; obs is the parsed observation
function init(matchData)          optional; parsed bootstrap, or null, once at load
detail                            optional global: sections read in full ("all" or a list)
log(...args)                      provided; appends one log line
```

- `think` must return an **array**, synchronously. Its contents must be JSON data: `null`, booleans, finite numbers,
  strings, arrays and plain objects (prototype `Object.prototype` or `null`). `undefined`, functions, symbols, BigInt,
  `NaN`/`Infinity`, class instances and cycles are `bad_output`.
- `log`: strings are written verbatim; other values as `JSON.stringify` (falling back to `String`), separated by spaces.
- Available: the ECMAScript standard library (`JSON`, `Math`, `Map`/`Set`, typed arrays, `RegExp`, `Proxy`, `Promise`, …).
  Not available: `console`, `require`, `process`, `fetch`, `setTimeout`/`setInterval`, `performance`, `WebAssembly`, the
  QuickJS `std`/`os` modules, and any other host object.

Minimal example (intent kinds and observation fields come from the game's manifest; this one attacks the weakest
visible enemy):

```js
let lastTarget = null;

function think(obs) {
  if (obs.enemies.length === 0) return [{ kind: 'hold' }];
  let target = obs.enemies[0];
  for (const e of obs.enemies) if (e.hp < target.hp) target = e;
  if (target.id !== lastTarget) log('new target', target.id, 'hp', target.hp);
  lastTarget = target.id;
  return obs.units.map((u) => ({ kind: 'attack', unit: u.id, target: target.id }));
}
```

## WebAssembly ABI

A core module (`\0asm` version 1), any source language.

**Exports**

| Name | Kind / type | |
|---|---|---|
| `memory` | memory | Defined by the module (not imported), 32-bit, unshared, standard 64 KiB pages, **must declare a maximum**. |
| `alloc` | `(len: i32) -> i32` | Returns a pointer to `len` writable bytes for bootstrap or observation JSON. |
| `think` | `(ptr: i32, len: i32) -> i64` | Returns `(outPtr << 32) \| outLen` of the output. |
| `init` | `(ptr: i32, len: i32) -> ()` | Optional; receives bootstrap JSON once after instantiation (after the start function), before think. |

An optional custom section `playerthree.detail` declares the observation detail (above, *Observation detail*).

**Imports.** Exactly one is permitted, and it is optional:

| Name | Type | |
|---|---|---|
| `env.log` | `(ptr: i32, len: i32) -> ()` | Appends one log line: the bytes `[ptr, ptr+len)` as UTF-8 (invalid sequences become U+FFFD). |

Every other import — WASI, other `env` functions, imported memories, tables, globals, tags — is `imports_not_allowed`.

**Initialization.** If `init` is exported, the host encodes the bootstrap snapshot (or `null`) as UTF-8 JSON,
calls `alloc(len)`, checks the returned region and copies the bytes there, then calls `init(ptr,len)`. Keep any
needed state separately before reusing that region in later allocations. An invalid region fails loading with
`bad_output`; a trap fails loading with `threw`. A zero-argument `init` is a signature error, not a compatibility mode.

**Each call**

1. The host serialises the observation to UTF-8 JSON (`len` bytes) and calls `alloc(len)`.
2. It checks `[ptr, ptr+len)` lies inside `memory` and copies the observation there.
3. It calls `think(ptr, len)` and splits the `i64` (as unsigned): `outPtr = r >> 32`, `outLen = r & 0xffffffff`.
4. `[outPtr, outPtr+outLen)` must lie inside `memory`, be ≤ 1 MiB and hold a UTF-8 JSON **array** nested at most 32 levels; it is copied out
   immediately, so the buffer may be reused on the next call.

`alloc` is called on every call; memory management is the module's business (a bump arena reset per call is fine).
Pointers are unsigned. Traps (`unreachable`, out-of-bounds access, stack exhaustion, …) and a `log` with an
out-of-bounds range are reported as `threw`; the instance stays usable with whatever state the trap left.

**Static rules** (checked at load, before any code runs)

- Every memory declares a maximum, and the maxima together are ≤ `floor(memoryBytes / 65536)` pages. `memory.grow`
  past the maximum returns `-1`.
- Every table declares a maximum, 65,536 entries in total (tables live on the engine heap).
- No GC `struct`/`array` types (they would allocate on the engine heap without a static bound).
- No shared memories (there are no threads to share with, and `memory.atomic.wait` would let a call idle instead of
  compute).

### Minimal WAT

```wat
(module
  (import "env" "log" (func $log (param i32 i32)))
  (memory (export "memory") 2 16)                ;; at most 16 pages = 1 MiB
  (data (i32.const 0) "[{\"kind\":\"hold\"}]")   ;; 17 bytes of output
  (data (i32.const 32) "holding")

  ;; The observation goes at 64 KiB; grow memory to fit it.
  (func (export "alloc") (param $len i32) (result i32)
    (local $pages i32)
    (local.set $pages
      (i32.shr_u (i32.add (local.get $len) (i32.const 131071)) (i32.const 16)))
    (if (i32.gt_u (local.get $pages) (memory.size))
      (then (drop (memory.grow (i32.sub (local.get $pages) (memory.size))))))
    (i32.const 65536))

  (func (export "think") (param $ptr i32) (param $len i32) (result i64)
    (call $log (i32.const 32) (i32.const 7))
    ;; (outPtr << 32) | outLen
    (i64.or (i64.shl (i64.const 0) (i64.const 32)) (i64.const 17))))
```

If the observation does not fit, `memory.grow` fails, `alloc` still returns 65536, and the host reports `bad_output`
(`alloc returned a region outside memory`).

### Rust (`no_std`, `wasm32-unknown-unknown`)

`Cargo.toml`:

```toml
[lib]
crate-type = ["cdylib"]

[profile.release]
panic = "abort"
opt-level = "s"
lto = true
```

`src/lib.rs` (Rust 1.82 or newer, any edition):

```rust
#![no_std]

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn log(ptr: *const u8, len: usize);
}

const INPUT_CAP: usize = 256 * 1024;
static mut INPUT: [u8; INPUT_CAP] = [0; INPUT_CAP];
static mut OUTPUT: [u8; 1024] = [0; 1024];
static mut CALLS: u32 = 0;

/// The host asks for `len` bytes and copies the observation (UTF-8 JSON) there.
#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len > INPUT_CAP {
        // trap → `threw`
        core::arch::wasm32::unreachable();
    }
    unsafe { core::ptr::addr_of_mut!(INPUT) as *mut u8 }
}

/// Returns `(ptr << 32) | len` of a UTF-8 JSON array of intents.
#[unsafe(no_mangle)]
pub extern "C" fn think(ptr: *const u8, len: usize) -> u64 {
    let obs = unsafe { core::slice::from_raw_parts(ptr, len) };
    let units = obs.windows(5).filter(|w| *w == b"\"id\":").count() as u32;
    let calls = unsafe {
        // state persists between calls of one instance
        CALLS += 1;
        CALLS
    };
    let msg = b"counted units";
    unsafe { log(msg.as_ptr(), msg.len()) };

    let mut out = Out { buf: unsafe { &mut *core::ptr::addr_of_mut!(OUTPUT) }, len: 0 };
    out.put(b"[{\"kind\":\"hold\",\"units\":");
    out.num(units);
    out.put(b",\"calls\":");
    out.num(calls);
    out.put(b"}]");
    ((out.buf.as_ptr() as usize as u64) << 32) | out.len as u64
}

struct Out {
    buf: &'static mut [u8],
    len: usize,
}

impl Out {
    fn put(&mut self, s: &[u8]) {
        self.buf[self.len..self.len + s.len()].copy_from_slice(s);
        self.len += s.len();
    }
    fn num(&mut self, mut v: u32) {
        let mut digits = [0u8; 10];
        let mut i = digits.len();
        loop {
            i -= 1;
            digits[i] = b'0' + (v % 10) as u8;
            v /= 10;
            if v == 0 {
                break;
            }
        }
        self.put(&digits[i..]);
    }
}
```

Build — the linker must declare the memory maximum, and Rust's default 1 MiB stack is far more than a policy needs:

```sh
RUSTFLAGS="-C link-arg=--max-memory=4194304 -C link-arg=-zstack-size=65536" \
  cargo build --release --target wasm32-unknown-unknown
```

`--max-memory` is in bytes (a multiple of 65,536, here 64 pages) and must fit `memoryBytes`. `wasm-ld` exports the
memory as `memory` and gives the function table a fixed maximum by default (do not pass `--growable-table`); the
`__data_end`/`__heap_base` exports it adds are harmless. Any toolchain that links with `wasm-ld` (C, C++, Zig) uses the
same `--max-memory` flag.

## Performance

Per-call cost with a ~50 KB observation (560 units), measured by the test suite on a desktop CPU, host-observed time
including serialisation and the cross-thread round trip (`PolicyCallResult.ms` reports only the sandbox-side part):

| Runtime | Mean | Notes |
|---|---|---|
| `wasm` | ~0.4 ms | Fixed overhead (shared-memory round trip) is ~0.05 ms; the rest is JSON serialisation and the policy's own scan. |
| `js` | ~3–5 ms | Dominated by QuickJS parsing the observation (~1.5 ms per 50 KB) and the interpreter. |

Keep observations compact and `msPerCall` comfortably above these numbers; a JS policy that must re-parse a large
observation every tick is better written for `wasm`.
