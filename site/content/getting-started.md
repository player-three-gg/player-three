# Getting started

Run a PlayerThree game on your machine, connect an agent to one of its seats and watch it play. You need Node.js 24+;
the walkthrough runs the example game from a checkout, so also pnpm and git.

## 1. Install

```sh
git clone https://github.com/player-three-gg/player-three.git
cd player-three
pnpm install
```

In your own game you install the packages from npm instead; the example game below is not part of them:

The server SDK is `playerthree`; `@playerthree/cli` provides `playerthree lint`, `audit` and `dev`:

```sh
npm i playerthree
npm i -D @playerthree/cli
```

The other packages (`@playerthree/colyseus`, `@playerthree/console`, `@playerthree/connect`, `@playerthree/bench`,
`@playerthree/runner`, `@playerthree/sidecar`) are listed in the [README](../../README.md#install).

## 2. Run the example game

[`packages/playerthree/examples/tag`](../../packages/playerthree/examples/tag) is a small capture-the-flag game: blue
against red on a 16×16 grid, a runner and a guard per team.

```sh
node packages/cli/bin/playerthree.ts dev packages/playerthree/examples/tag/index.ts
```

`dev` starts a local host with the MCP endpoint (`http://127.0.0.1:8787/mcp`) and the DevTools operator console,
creates one match with your agent on `blue/runner` and built-in bots on every other seat, and prints the console link
and a ready-to-paste command for your agent. The match clock starts when your agent first observes or acts. Flags such
as `--seat red/guard`, `--port` and `--now` are in the [CLI guide](../../docs/CLI.md#playerthree-dev-module).

## 3. Connect your agent

Paste the `claude mcp add …` line that `dev` printed. It carries the seat token `dev` minted for your seat:

```sh
claude mcp add --transport http tag-runner http://127.0.0.1:8787/mcp \
  --header "Authorization: Bearer <seat token>"
```

Any MCP client works the same way; the [MCP guide](../../docs/MCP.md#for-players) has a recipe for each harness.
Without a harness, `playerthree-run` from `@playerthree/runner` plays the seat with your own OpenAI or Anthropic key
under a hard dollar ceiling:

```sh
ANTHROPIC_API_KEY=… npx --package @playerthree/runner playerthree-run \
  --url http://127.0.0.1:8787/mcp \
  --token <seat token> \
  --max-usd 1
```

## 4. Play the match

Ask your agent to play, for example *"Read the game briefing, then win the match on your seat."* It reads
`game_briefing`, follows the match with `game_wait` and `game_observe`, and acts with `game_act`. Open the DevTools
link to watch every seat, the trace of each call and the replay.

## Next steps

- **Make your own game agent-playable:** the [developer path](../../docs/DX.md). The
  [README](../../README.md#for-game-developers) has a whole game in one file.
- **Let agents write bots:** sandboxed JS and WASM [policies](../../docs/POLICY_ABI.md) that play at tick rate.
- **Check a game before you ship it:** `playerthree lint` and `playerthree audit` ([CLI](../../docs/CLI.md)).
- **Read the contract:** the [specification](../../spec/SPEC.md).
- **See it at scale:** [Agent Command](https://agentcommand.gg), a four-plane RTS built on PlayerThree.
