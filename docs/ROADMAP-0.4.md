# CodaClauda 0.4 — the "10/10" release

Owner request (Ben, 2026-10-14): list what would take CodaClauda from a 7/10 to
a 10/10, keeping only items that are feasible. Ordered by impact. 0.3.0 ships the
happy-path chat, message board, task board, 3D project city and photo avatar.

Feasibility key: **Verified** = checked against the installed tool on 2026-10-14.
**Known** = documented, standard capability, not yet exercised here.
**Partial** = only part of the item is possible; the limit is stated.

| # | Item | Feasibility | Evidence / limit |
| --- | --- | --- | --- |
| 1 | **Agents that remember and answer in seconds.** CodaClauda owns long-lived agent sessions and resumes them per message instead of starting fresh or waiting for a desktop chat's heartbeat. Chat feels like ChatGPT/Claude, with memory. | Verified | `codex exec resume <SESSION_ID> [PROMPT]` exists in codex-cli 0.162.0-alpha.17.2; `claude -p --resume <session-id>` with `--output-format stream-json` exists in Claude Code 2.1.295. The coordination adapter already records each provider's real session ID. Work: a `resume-session-v2` adapter + streaming tokens to the chat. Existing desktop chats still can't be pushed into; this replaces the need for that in day-to-day use. |
| 1b | **Chat modes** (Ben, 2026-10-14): per agent, choose *Desktop chat* (today's passive mailbox to an existing Claude/Codex desktop conversation, visible in that app) or *CodaClauda session* (hosted and resumed by CodaClauda: instant, with memory, model/effort set per agent), with an "Open in terminal/desktop" escape hatch. | Partial | Resume is verified (row 1). Unverified: whether CLI-started sessions appear in the Claude/Codex desktop apps' history, and any supported way to open a specific session in those apps; the terminal fallback works. Not forced into 0.3.0. |
| 2 | **City as a control surface.** Drag an agent onto a building to assign work; click a building for branch, open PRs, CI status and the latest diff. | Known | Pure UI plus `gh pr list/run list --json` (gh is installed and signed in as delores88) and local `git`. Assignment posts the same mailbox task used in 0.3. |
| 3 | **Real agent status instead of inferred status.** One structured `status_update` (project, step, % done, blocker) that both MCP sessions and CLI users can post; NPCs act it out (typing at a desk, waiting, red gem when blocked). | Known | Add a mailbox `status` kind + CLI command + MCP tool in coord-core. 0.3 infers status from messages/claims/requests; 0.4 makes it explicit. Agents must choose to post it — CodaClauda can't observe a desktop chat by itself. |
| 4 | **Cost and usage meters** per agent and provider, with "send this to the cheaper agent". | Partial | Claude stream-json reports `total_cost_usd` (an estimate, not an invoice) and tokens. Codex JSONL reports tokens; on a ChatGPT subscription there is no per-request dollar figure, so Codex shows tokens and subscription usage only. Never invent a dollar amount. |
| 5 | **Notifications that reach you.** Native Windows toasts with "Reply" action; optional phone push. | Partial | Windows toasts: tauri-plugin-notification (MIT/Apache, free). Phone push: optional, via a free self-hostable service such as ntfy (Apache-2.0); off by default, never requires a paid account. |
| 6 | **60-second onboarding** for new users: detect CLIs → scan Desktop → link GitHub → the city builds itself → pick or photo-build an avatar. | Known | All pieces exist in 0.3; 0.4 strings them into a guided first run. |
| 7 | **Ambient signals that carry meaning.** Day/night synced to your clock; rain over a building whose CI is failing; fireworks on a merged PR; sound design with a mute switch. | Known | `gh run list --json conclusion` per repo; three.js particles. Respects reduced-motion. |
| 8 | **Agent-built avatars end to end.** Upload a photo → choose Claude or Codex → the agent returns a richer spec (and optionally a custom 3D accessory) → one-click apply. | Known | 0.3 already sends the request and applies a JSON spec from the reply; 0.4 adds progress, preview diff and accessory meshes. |
| 9 | **Shared world for teams** (several owners, one city). | Deferred | Needs a real sync service and identity; out of scope until single-owner use is solid. Listed so it isn't forgotten, not promised. |

Release rule unchanged: Codex builds installers and runs Marketplace submission;
Claude owns UI. Nothing publishes without Ben's explicit "ship it".
