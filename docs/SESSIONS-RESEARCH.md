# Sessions research: what Codex and Claude Code allow (checked 2026-10-16)

Ben asked ChatGPT how a single app could start, resume, approve and connect Codex and
Claude Code agents. This file records which of its claims hold, from local checks of the
installed CLIs and the official docs. It feeds the 0.4 sessions work in
[ROADMAP-0.4.md](ROADMAP-0.4.md).

**Method.**
- **Installed tools:** Codex is bundled with the Codex desktop app (codex-cli 0.162.0-alpha.17.2), with an older npm codex 0.153.4 on PATH. Claude Code 2.1.295 is bundled with the Claude desktop app.
- **Local checks** used only `--help`, `--version` and generating the Codex app-server protocol schema into a temporary folder. No login, no model sessions, no config changes, no credential files opened.
- **Doc checks** used OpenAI and Anthropic sources. Most of their pages carry no date.
- **Checking:** two researchers checked the claims, then a skeptic re-ran the most important ones.
- **Conflict of interest:** the checkers were Claude models (Anthropic). The Anthropic policy claims were checked against primary sources.

**Overall verdict:** ChatGPT was mostly right. Of its 16 checkable claims, 13 hold as stated, 3 are only partly right (C2, C5, L5), and none are false. It skipped two of Ben's questions, which are answered below as C8/C9 and L9/L10. Those answers carry the two biggest design limits:
- approvals from another app only reach agents that app runs itself;
- computer use is not available to CLI agents on Windows.

## Codex

| # | ChatGPT claim | Verdict | What we found |
|---|---|---|---|
| C1 | `codex mcp-server` was removed | **True** | Removed in PR #42993 (merged 2026-09-05). First stable release without it: 0.154.0. The bundled 0.162 has no `mcp-server` (measured). **The npm 0.153.4 on PATH still has it**, so anything built on it breaks on upgrade. `codex mcp` (managing external MCP servers) still exists. |
| C2 | `codex app-server` is the supported external interface (threads, execution, events) | **Partly** | It is OpenAI's official rich-client interface (VS Code uses it). The local 0.162 schema has 170 client methods and 84 notifications, including `thread/start`, `thread/resume`, `turn/start` and `turn/interrupt`. **But it is labelled experimental** and "not supported for production"; OpenAI points automation and CI at the Codex SDK. Pin the version, because the protocol changes between releases. |
| C3 | Threads persist, resume after restart, stored locally | **True** | JSONL logs under `CODEX_HOME/sessions` (default `%USERPROFILE%\.codex`), with SQLite metadata. `--ephemeral` threads are not saved. A resume needs the same `CODEX_HOME`. |
| C4 | Automatic and manual compaction | **True** | Config `model_auto_compact_token_limit`; manual `/compact`; app-server `thread/compact/start` with a `thread/compacted` event. |
| C5 | AGENTS.md instructions; cross-session memory "more limited" | **Partly** | AGENTS.md is right. **Outdated on memory:** Codex now has a "Memories" feature that writes background summaries of past chats into `CODEX_HOME/memories`. It is off by default and turned on with `[features] memories = true` or in Settings. |
| C6 | Separate `CODEX_HOME` per account; app-server `account/login/start` returns a login URL; device-code and API-key login | **True** | Measured in the schema. Login types: apiKey, chatgpt (returns authUrl), chatgptDeviceCode (verificationUrl plus userCode), and unstable/internal types. `account/login/completed` reports success or failure. Per-`CODEX_HOME` isolation comes from the docs plus the source code, not from an advertised multi-account feature. |
| C7 | OpenAI documents multi-account "Sign in with ChatGPT" for open-source apps; paid or hosted apps need approval | **True** (docs undated) | The developers.openai.com Sign in with ChatGPT pages cover saved profiles and switching accounts without signing out. The criteria for approving paid or remote apps were not read. |
| C8 | *(not answered)* Can another app approve a Codex agent? | **Partly** | **Yes, if your app is the app-server client running that thread.** The server sends `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` and similar requests, which can be answered with accept, acceptForSession, decline or cancel. **No** for agents in another process. Whether CodaClauda could approve threads that the Codex desktop app itself runs is undocumented. |
| C9 | *(not answered)* Computer use? | **Partly** | Only in the Codex/ChatGPT **desktop app**, through the Computer Use plugin (Windows and macOS; it takes over the mouse and keyboard). **Not in the CLI or app-server sessions that CodaClauda would start.** |

## Claude Code

| # | ChatGPT claim | Verdict | What we found |
|---|---|---|---|
| L1 | Sessions persist, resume after restart, stored locally | **True** | `-c/--continue` and `-r/--resume <id>` (measured). JSONL at `%USERPROFILE%\.claude\projects\<project>\<session-id>.jsonl`. |
| L2 | Automatic and manual compaction | **True** | `--autocompact <auto\|tokens>`, `/compact [focus]` and `/autocompact`. `DISABLE_AUTO_COMPACT=1` turns off automatic compaction only. |
| L3 | CLAUDE.md instructions; built-in auto memory | **True** | CLAUDE.md is read from managed, user, project and local scopes, plus `.claude/rules`. AGENTS.md is read since v2.1.277 (setting-dependent). `/memory`. |
| L4 | Agent SDK = programmatic integration with persistent sessions and events | **True** | Python and TypeScript libraries that run the Claude Code binary. Sessions use the same `~/.claude/projects` layout; resume and fork are supported. |
| L5 | `CLAUDE_CONFIG_DIR` isolates accounts | **Partly** | Documented for staying signed in to several accounts: each directory gets its own settings, history and login. **Caveat:** a Console sign-in without an API key is stored outside it (`%APPDATA%\Anthropic`). |
| L6 | `ANTHROPIC_API_KEY` overrides the subscription | **True** | In the documented precedence, an API key outranks subscription OAuth. **In `-p` (non-interactive) mode the key is always used when present**, so sessions CodaClauda starts would bill the API whenever that variable is set. |
| L7 | Third-party products need approval to offer claude.ai login or rate limits; API keys are the default | **True** | The Agent SDK overview says so, and the legal and compliance page says products "should use API key authentication". |
| L8 | "Anthropic confirmed on Oct 7, 2026 that SDK and third-party apps can keep using subscription limits" | **True** | Claude Help Center article 15036540 (modified 2026-10-07). Max and Team plans now include monthly API credits covering the SDK and `claude -p`, and "you can still use the Claude Agent SDK, claude -p, and third-party apps with your subscription limits." This sits alongside L7's developer rules; see the first constraint below. |
| L9 | *(not answered)* Can another app approve a Claude Code agent? | **Partly** | The documented path is the **Agent SDK** permission callback. The CLI has `--permission-prompts host` and a **hidden** `--permission-prompt-tool <mcp tool>` (print mode only). Both work, but the hidden flag is not a stable, documented contract for non-SDK hosts. |
| L10 | *(not answered)* Computer use? | **Partly** | In the Claude Code CLI only as a **macOS research preview** (Pro/Max, interactive only). **Not in the CLI on Windows.** The Claude desktop app on Windows has it as a research preview. |
| L11 | Browser-based login; credentials stored locally | **True** | `claude auth login` (`--claudeai`, `--console`, `--sso`), `claude setup-token` and `auth status`. Credential files were not opened. |

## What this means for CodaClauda 0.4 sessions

1. **Codex sessions should use `codex app-server`, pinned to a version.** It is the only path where CodaClauda receives approval requests, which the "Ask me" access level needs. `codex exec` cannot ask. `mcp-server` is gone. Treat app-server as experimental: version-check it at startup and fall back to `exec resume` for the Read only, Work freely and Full access levels.
2. **Claude sessions should use `claude -p --output-format stream-json`, with `--input-format stream-json` for multi-turn and `--resume <id>`.** Use permission-mode flags for the fixed levels. "Ask me" for Claude needs either the Agent SDK, which means a small Node sidecar, or the hidden `--permission-prompt-tool`. Decide when the work starts; the hidden flag can change without notice.
3. **Control the launch environment.** Start every session with an explicit environment. Remove `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `CODEX_API_KEY` unless that agent is set to use an API key, so a stray key never switches billing silently. Ben's machine has none of these set today (checked 2026-10-16).
4. **Never handle credentials.** CodaClauda launches the user's own installed CLIs, which use their own login. Per-agent accounts come later, through `CODEX_HOME` or `CLAUDE_CONFIG_DIR` profiles; login happens in the provider's browser flow, never in CodaClauda.
5. **Let each tool keep its own conversations.** Don't rebuild history, compaction or memory, because each tool already handles them. CodaClauda stores only session IDs, task ownership, messages, approvals, and key decisions/acceptance criteria. Compaction loses detail, so those decisions must live outside the conversations, on the board.
6. **Agents started by CodaClauda have no computer use on Windows.** Desktop-control work stays in the Codex and Claude desktop apps.
7. **Housekeeping:** update or remove the stale npm codex 0.153.4 on PATH, and always launch the desktop-bundled CLI.

## Constraints and open questions

- **Subscription vs API key for a distributed app (L7 vs L8).** For Ben's own machine, launching his own signed-in CLIs with his subscription is covered by L8. If CodaClauda is distributed to others, Anthropic's developer pages still say products should use API keys unless approved. The legal page appears to allow an end user signing in to the *unmodified* Claude Code binary, which is what wrapping the CLI does, but no page addresses this case explicitly. **Confirm with Anthropic before advertising subscription use in a distributed CodaClauda.** For OpenAI, open-source, locally run apps are the documented "Sign in with ChatGPT" case, and paid or hosted apps need approval.
- **Unanswered:**
  - whether the Codex desktop app's own threads can be joined by an external app-server client;
  - whether Claude Desktop (Code tab) sessions can be resumed from the CLI and the other way round;
  - whether `~/.claude.json` moves under `CLAUDE_CONFIG_DIR`;
  - the Agent SDK's feature parity on Windows.
