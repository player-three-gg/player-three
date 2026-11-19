## What and why

<!-- The behaviour change and the reason. Link issues: `Fixes #<issue>` -->

## Verification

<!-- Exactly what you ran (proportional checks, see CONTRIBUTING.md). -->

- [ ] `pnpm -r typecheck`
- [ ] Tests for the touched packages/files ran green (`--maxWorkers=1`/`2`)
- [ ] Protocol change: spec updated first
- [ ] `../agent-command` still typechecks; ran `pnpm bench:pin` there if the agent-facing surface changed
- [ ] Screenshots / recording attached for UI changes
- [ ] Docs updated where behaviour changed
- [ ] No backward-compat shims; every caller updated
- [ ] Commits are signed off (`git commit -s`, DCO)
