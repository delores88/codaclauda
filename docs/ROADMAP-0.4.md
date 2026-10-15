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

## Notes: start and run agents without the desktop apps (Ben, 2026-10-15)

Owner decision: this is 0.4 work, explicitly **not** part of 0.3.2. 0.3.2 only fixes
the agent-setup prompts, the zoom pitch and the NPC talk view. These notes extend
rows 1 and 1b.

Today CodaClauda cannot start a desktop chat. The mailbox only passes messages, so a
new agent starts in the Claude Code or Codex app and joins by pasted prompt. Owning
sessions removes that step:

1. **Start agent.** Pick Claude Code or Codex, a project and a task. CodaClauda
   launches the user's installed CLI, records the provider session ID and registers
   the session's mailbox address automatically.
2. **Wake on mail.** When a message arrives for a CodaClauda-owned agent, resume its
   session for one turn (`claude -p --resume`, `codex exec resume`, or Codex's
   app-server protocol). This gives real push and instant replies in the City talk
   view. Each wake costs a model turn on the user's plan, so show it and allow a
   per-agent off switch.
3. **Approvals in-app.** Headless sessions cannot ask in their own window. Route their
   permission requests to the Approvals view: Codex app-server emits approval events;
   for Claude Code, use a pre-set allowed-tool list or SDK permission callbacks.
4. **Stop and resume controls, with transcripts streaming into Chat** (stream-json / JSONL).

Constraints to respect:
- **Auth.** Wrap the user's own installed CLI and its existing login, as Conductor,
  Claude Squad and Vibe Kanban do. Anthropic's Agent SDK docs say third-party products
  built on the SDK should use API-key auth rather than claude.ai login unless approved,
  so building on the SDK means asking users for API keys.
- **Desktop history.** Unverified whether CLI-started sessions appear in the Claude or
  Codex desktop apps. Assume they live in CodaClauda only.
- **Market.** Starting and stopping sessions is commodity: the platforms ship it
  (Claude Code parallel sessions and Agent Teams, the Codex app, GitHub Agent HQ). Its
  value here is removing copy-paste between apps. The differentiators remain
  cross-provider in one place plus the City.
- **Rough size (estimate).** Several days of agent-built work. CodaClauda's Live chat
  already launches dedicated CLI sessions; the gap is keeping one alive and resumable
  per agent.

Release rule unchanged: Codex builds installers and runs Marketplace submission;
Claude owns UI. Nothing publishes without Ben's explicit "ship it".
