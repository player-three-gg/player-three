# @playerthree/runner

## Unreleased

- `playerthree-run --reasoning-effort low|medium|high|xhigh|off`, default `medium` (`DEFAULT_REASONING_EFFORT`): sent on every turn (OpenAI `reasoning.effort` with encrypted reasoning returned, Anthropic adaptive thinking at `output_config.effort` with signed thinking returned); `off` sends none, for models without reasoning.
- `systemPrompt` keeps the deploy-first step, no longer limits reading ("before reading anything else", "only when a decision needs them"), and says a policy is code the model can write or fork (`policy_deploy {code}` or `{modules, entry}`, skill `playerthree-policy-author`, topic `modes`) and that improving it is how it plays well.
- `createAnthropicProvider` authenticates with a bearer token when `baseUrl` is set (OpenRouter's `/api/v1/messages`, an auth gateway) and `x-api-key` on Anthropic's API (`anthropicAuthHeaders`); `ANTHROPIC_VERSION` and `ANTHROPIC_EFFORT_BETA` are exported.
- `seatBrief(seat, game)`: the seat's facts (title, game summary, server instructions) without the runner's play advice. `runAgent({authoring: true})` re-prompts, opens, notes roles and reports output-cap cuts without advice.
- `ProviderOptions.reasoningEffort`: one effort for every request, OpenAI Responses `reasoning.effort` (any model) or Anthropic adaptive thinking at `output_config.effort`; absent, OpenAI reasoning models stay at `low`.

## 0.1.0

Initial public release: `playerthree-run`, an agent runner with your own model key and a hard budget, and `playerthree-mcp`, the pinned MCP stdio bridge.
