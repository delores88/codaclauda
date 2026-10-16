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

## 0.4 scope decided by Ben (2026-10-16)

### Project access levels replace Windows Hello approvals
Ben's decision: no Windows Hello. The app owns approval state. Access is set **per
project** and applies to every agent that works on that project, so individual agents
need no separate approval. This replaces the "Signed one-click approvals (Windows
Hello) are planned for 0.4" line in the Approvals view.

- **Levels**, each with its own colour (flags verified 2026-10-16 on codex-cli 0.162.0-alpha.17.2 and Claude Code 2.1.295; re-check at implementation time, because both CLIs change often):
  - **Read only:** Codex `exec -s read-only`; Claude `--permission-mode plan`.
  - **Ask me:** the agent's approval requests appear in CodaClauda's Approvals view.
    - Codex: approval events from `app-server`, or `-a on-request` interactively. `codex exec` cannot ask.
    - Claude: `--permission-mode manual`, with requests routed to CodaClauda.
  - **Work freely in the project:** Codex `exec -s workspace-write --approve-for-me`; Claude `--permission-mode acceptEdits` (or `auto`) plus a project allowed-tools list.
  - **Full access**, like Codex's own full-access mode: Codex `--dangerously-bypass-approvals-and-sandbox` (or `-s danger-full-access`); Claude `--permission-mode bypassPermissions`.
- **Optional action toggles:** build/test, deploy, publish releases, Marketplace submit/retry.
  Spending is never included.
- **Enforcement is real only for sessions CodaClauda launches** (item 1): the level becomes
  the CLI launch flags and tool allow/deny lists. Release and deploy toggles map to tool
  patterns where the CLI supports them (Claude `--allowedTools` / `--disallowedTools`, e.g.
  `Bash(gh release:*)`); otherwise they are standing instructions in the session.
  Desktop chats that CodaClauda did not start keep their own app's permissions; for them the
  level stays advisory paste text, as today.
- **Policy file.** The policy lives in CodaClauda's app data, outside every workspace, and only
  changes from CodaClauda's own UI. A sandboxed agent (read-only, or workspace-write) cannot
  edit it. An agent already on Full access could, but it can already do anything. Mailbox
  messages never change it.
- **3D ticker:** a full-colour, smooth (not pixelated) ticker band wraps all four sides near the top of
  each building. It scrolls the project's access level, active agents and toggles in the
  level's colour. Clicking it opens an access popover for the project. Twin buildings on the
  Spark side show the same ticker, greyed out while the Spark is offline.
- **Projects view:** the same level selector and toggles per project, for anyone who prefers not to
  use the 3D world.

### Unified chat: a full chat app for people who skip the 3D world (Ben, 2026-10-16)
Goal: Chat on its own should feel like the Claude Code and Codex desktop apps, a complete,
standard chat that unifies both providers' agents around **projects**.
- **Project dropdown** at the top of Chat, as in Claude Code and Codex. It uses the same project
  model as the City and Projects views (local folders plus GitHub repos), and filters the conversation list to that project.
- **New chat in a project:** pick the agent (Claude Code or Codex), plus model and effort where the CLI
  supports them. CodaClauda starts a session in the project folder (item 1). Existing mailbox
  desktop chats show in the same list, clearly labelled "desktop chat (replies when it checks in)".
- **Connected resources panel** for the active chat:
  - workspace folder;
  - git branch and dirty state;
  - GitHub repo link;
  - the project's access level;
  - attached MCP tools (for example Playwright or Windows-MCP, below);
  - Spark/DGXBridge availability;
  - attached files.
  It is the equivalent of Claude's connectors and Codex's environment indicator.
- **Parity checklist (what users expect from those apps):**
  - streaming replies with stop;
  - edit-and-resend and regenerate;
  - collapsible tool-call activity;
  - inline diff/patch previews of agent changes;
  - inline approval buttons for "Ask me";
  - attachments;
  - mic;
  - markdown, math and code with copy (all three exist today).
- **Chat-first layout option:** a setting hides the City and other 3D entry points from the rail
  for people who never want them. The City stays one click away.
- **Depends on sessions** (item 1) for real-time replies and on project access levels for the
  resources panel. Most of the UI is new, but it reuses the Chat view's renderer and composer.

### Computer use for CodaClauda-started agents (Ben, 2026-10-16)
Background (see [SESSIONS-RESEARCH.md](SESSIONS-RESEARCH.md)): the Claude Code CLI has computer use
only as a macOS preview, and Codex has it only in its desktop app. Both CLIs accept MCP servers
(Claude `--mcp-config` / `claude mcp add`; Codex `codex mcp add` / config.toml), so one tool can
give both agents desktop or browser control.

| Tool | What it gives | Checked 2026-10-16 |
|---|---|---|
| Playwright MCP (Microsoft) | Browser automation through the page structure; reliable for web tasks | Apache-2.0, ~38k stars |
| Windows-MCP (CursorTouch) | Windows desktop control: UI Automation, screenshots, mouse and keyboard | MIT, ~9.2k stars, active; third-party |
| Chrome DevTools MCP (Chrome team) | Drive and debug Chrome | Apache-2.0, ~54k stars |
| CodaClauda's own guarded tool | Desktop control with built-in guardrails | Estimate: 1-2 days; consider after the above prove out |

Plan:
1. Attach **Playwright MCP by default** to sessions CodaClauda starts.
2. Make **Windows-MCP opt-in per project, Full access level only**, with a visible stop control.
3. Pin versions and vet updates; this is third-party code running with the user's rights.
4. Treat on-screen text as untrusted (prompt-injection risk).
5. Windows-MCP takes over the mouse and keyboard while it runs.
6. Keep the desktop apps for heavy desktop work until this has proven itself.

### Moved to 0.3.3 (Ben, 2026-10-16)
These were planned here but ship early in 0.3.3:
- island portals to repos you contribute to (route map plus portal);
- City weather: Off, Live (MET Norway, free) or Pick your own;
- the talk-view fixes and board fixes;
- the non-affiliation line in Settings (the README line is Codex's).

### Also in 0.4 (deferred from the 0.3.x work)
- **Zero-config City:** show existing Claude Code and Codex sessions without setup. This was the
  research's top differentiator. macOS support is a follow-on.
- **Decide on Conversation setup** (registered chats, private MCP) and the old request-history
  board, which 0.3.2 did not port: rebuild or retire. The unified chat above may replace both.
- **Signed installers:** the Microsoft Store (free) or Azure Artifact Signing (about $10 a month).
- **Dependency advisory:** glib 0.18.5 GHSA-wrw7-89jp-8q8g (Codex maintenance).

### Not doing now
- **Rename:** Ben keeps the CodaClauda name for now (2026-10-16). The trademark risk around
  "Clauda" is acknowledged; revisit before any public promotion.
- **Windows Hello signed approvals:** replaced by app-managed project access levels.

### Later (0.5)
Rows 2-8 above: City control surface, explicit agent status, cost meters, notifications,
60-second onboarding, ambient signals and agent-built avatars end to end. Row 9 stays parked.

Release rule unchanged: Codex builds installers and runs Marketplace submission;
Claude owns UI. Nothing publishes without Ben's explicit "ship it".
