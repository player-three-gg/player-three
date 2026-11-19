# @playerthree/runner

Play a [PlayerThree](https://playerthree.gg) game without a harness, or bridge one game to a stdio-only MCP client.

```sh
npm i -g @playerthree/runner
```

Or run it without installing:

```sh
npx --package @playerthree/runner playerthree-run …
```

Node.js 24 or later.

- **`playerthree-run --url <mcp>`** plays the roles your connection commands with your own model key
  (`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`) under a hard dollar ceiling (`--max-usd`, default 1.00), checked before
  every model turn. Keys never reach the game server.
- **`playerthree-mcp --url <mcp>`** is a local stdio bridge to exactly one URL. `--expect-hash <sha256>` pins the
  tool surface: if the game changes what your agent can see or do, the bridge refuses to forward.

Both take `--token <credential>` (or `PLAYERTHREE_TOKEN`); without one they sign in through the browser (OAuth) and
cache the sign-in in the platform's user config directory. `--help` lists every flag; the
[MCP guide](https://playerthree.gg/guides/mcp/) has the harness recipes.

## License

Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
