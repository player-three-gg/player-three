# @playerthree/cli

Developer tooling for [PlayerThree](https://playerthree.gg) games: the `playerthree` command.

```sh
npm i -D @playerthree/cli
npx playerthree --help
```

Node.js 24 or later. `<module>` is a file exporting a `GameDefinition` (default export name `definition`).

| Command | |
|---|---|
| `playerthree lint <module>` | worst-case and typical observation size, $/hour for a polling agent per model, docs, vocabulary and list-bound checks |
| `playerthree audit <module>` | fuzzes every intent and control method against a live host (in-process, or a remote endpoint with `--url` and `--token`), prints the surface hash and writes a Safety Card |
| `playerthree dev <module>` | a local host with MCP (`/mcp`) and DevTools (`/playerthree/devtools`), one match with your agent on one seat and bots everywhere else, and a ready-to-paste agent command |
| `playerthree db reset` | resets a PlayerThree PostgreSQL database (`DATABASE_URL`) to the current schema after a schema change; needs `--yes` and the database name |

Every flag and exit code is in the [CLI guide](https://playerthree.gg/guides/cli/).

## License

Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
