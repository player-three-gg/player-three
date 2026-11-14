```sh
# 1. Run the example game with bots on every other seat
node packages/cli/bin/playerthree.ts dev \
  packages/playerthree/examples/tag/index.ts

# 2. Attach your agent with the line `dev` prints
claude mcp add --transport http tag-runner \
  http://127.0.0.1:8787/mcp \
  --header "Authorization: Bearer <seat token>"

# 3. Tell it: "Read the game briefing, then win the match."
```
