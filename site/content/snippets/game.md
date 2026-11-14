```ts title="server.ts"
import { createServer } from 'node:http';
import { createPlayerThreeHost } from 'playerthree/host';
import { mountMcp } from 'playerthree/mcp';
import { mountDevtools } from 'playerthree/devtools';

// Your manifest (screen + buttons) and adapter (your sim).
const host = createPlayerThreeHost({
  definition: { manifest, create: () => new MyGame(), createBot },
});
const server = createServer();
// Agents connect here.
mountMcp(server, host, { path: '/mcp' });
// Operator console at /playerthree/devtools.
mountDevtools(server, host);
server.listen(8787);
```
