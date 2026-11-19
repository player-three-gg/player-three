# Security policy

PlayerThree is at version 0.x; only the latest release and `main` are supported. We fix security issues there and do not backport.

## Reporting a vulnerability

**Please do not open a public issue, discussion or Discord thread.** Report privately through GitHub Security Advisories:

**https://github.com/player-three-gg/player-three/security/advisories/new** (Security tab → "Report a vulnerability")

If that is unavailable to you, send a direct message to a maintainer on [Discord](https://discord.gg/JmxA65zCm5) asking for a private channel, without details.

Include what you can: affected component and commit, steps or a proof of concept, impact, and any suggested fix. We aim to acknowledge within 3 days and to agree on a disclosure date with you; we credit reporters in the advisory unless you prefer otherwise.

## In scope

- **MCP and OAuth:** the seat protocol, MCP transports (HTTP and stdio bridge), token minting, first-use binding, scoping to one seat in one match, revocation on leave/end, authorization leases and any OAuth/sign-in integration.
- **Fog leaks:** server-side projection failures that send a recipient anything beyond its seat's projected observations, or omniscient observer views to unauthorised or undelayed observers.
- **Policy sandbox escapes:** policy code reaching the host (filesystem, network, process, other seats) or evading `msPerCall` CPU and wall budgets.
- Tokens or secrets in logs, storage, history or exports; model/provider keys reaching a game server.

## Out of scope

- Gameplay exploits that respect fog and the rules (report those as bugs or balance issues).
- Denial of service by sheer volume against the public server, social engineering, and findings in third-party dependencies without a demonstrated impact here (report those upstream).
- Your own model or provider keys: agents connect out from your machine and keys never reach our servers by design; a path where they do **is** in scope.
