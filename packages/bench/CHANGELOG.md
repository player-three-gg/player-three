# @playerthree/bench

## Unreleased

- `BenchModel.wire` (`messages`, `responses`, `openrouter-chat`, `chat-completions`; `modelWire`, `MODEL_WIRES`): the OpenCode harness's API to the model and OpenCode's adapter for it, so signed or encrypted reasoning returns with tool results; the effort goes in the wire's own field. Turn records add `thinkingBlocks`, `thinkingChars`, `reasoningTokens`; the authoring session record names the wire. `continuationPrompt(status)` drops the time left.
- Authoring harnesses: `CampaignConfig.harness` and `openCodeHarness` (`@playerthree/bench/opencode`), one lobby commander per candidate, `SeriesSpec.authoring.starters` pre-deploy, `BenchModel.billing: "openrouter-key"` billed-usage ceiling (`routerKeyUsage`, `watchKeyUsage`), richer authoring ledgers and per-run `results/` with replays; turns charged at their router-reported cost (`turnCostUsd`, `routerGenerationCost`).
- `SeriesSpec.authoring.brief`: the series' evaluation statement, appended to every authoring session's brief.
- Authoring that reaches its deadline without one completed model turn is an infrastructure attempt (`no_model_turns`; OpenCode reports it as a provider or harness failure), never a scored `cutoff`; `HarnessOutcome.providerErrors` and the authoring ledger's `providerErrors` count failed provider requests, in-band error events in 200 replies included.
- `SeriesSpec.authoring.systemPrompt`: the model's whole system prompt in every authoring request under either harness (OpenCode's metering proxy replaces OpenCode's system messages with it; the runner moves its brief to the first user message); the suite publishes it with its SHA-256 (`systemPromptDigest`).
- Harness neutrality: `continuationPrompt` (OpenCode's no-early-exit re-prompt) is the time left and the seat's status only; the bench brief uses the runner's advice-free `seatBrief` and states the reply cap.
- `SeriesSpec.authoring.contextTokens` and `BenchModel.contextTokens`: one compaction window for every model (OpenCode's `limit.context`, default `OPENCODE_CONTEXT_TOKENS` = 250,000, was 128,000 from an operator option), capped at a model's own; published in the suite. The metering proxy replaces OpenCode's post-compaction "Continue if you have next steps, or stop and ask for clarification…" message with `continuationPrompt`, prompts go to `opencode run` on stdin (unquoted), and OpenCode's tool-output truncation sits above the game's result cap.
- A series run that loses its execution lease stops recording and `updates` ends with the store's `conflict`; the series stays resumable and the campaign exits nonzero instead of polling.
- `SeriesSpec.authoring.reasoning`: one reasoning effort for every authoring request (OpenCode's proxy sends `reasoning_effort`; the runner maps it per provider), published in the suite; authoring lobbies serve `McpOptions.authoring` server instructions and a status line without starter paths; the proxy moves OpenCode's message-level cache marks on plain-text user/system messages onto text parts so OpenRouter caches the first request of every run.

## 0.1.0

Initial public release: reproducible model benchmarks (seed-paired series, authoring harnesses including OpenCode, private transcripts, billed-cost ceilings, publications) and deterministic bot and policy balance sweeps, with the `playerthree-bench` CLI.
