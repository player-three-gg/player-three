# @playerthree/connect

DOM-free harness setup and connection types for [PlayerThree](https://playerthree.gg) games: render "connect your
agent" screens in your own UI.

```sh
npm i @playerthree/connect
```

- `HARNESSES`, `harness(kind)` and `harnessSetup(...)`: the setup text for Claude Code, the Claude API and Managed
  Agents, Codex, OpenCode, Pi, oh-my-pi, Hermes Agent, generic MCP clients and the PlayerThree runner and bridge.
- `kickoffPrompt(...)` and `MANDATE_PRESETS`: the first prompt and mandate presets for a seat's agent.
- Types for connections, consent requests and pairing codes served by the game's player API.

No Node or DOM dependencies. The [MCP guide](https://playerthree.gg/guides/mcp/) has every harness recipe.

## License

Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
