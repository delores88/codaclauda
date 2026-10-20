# CodaClauda 0.4 design review (2026-10-20)

An independent, skeptical review of docs/DESIGN-0.4.md. It was checked against the code, the installed CLIs' --help output and the generated Codex app-server schema, with no model calls. Conflict of interest: a Claude model reviewed a Claude-written design.

## Verdict

Approve with changes. Do not build it as written. The architecture holds up: a session engine in coord-core, a host in src-tauri, Claude stream-json, one owned Codex app-server per session, a separate sessions.json, and access read only from native policy. Most of the code and CLI claims I checked are accurate (adapters.rs, live_codex.rs, mailbox.rs, update_storage.rs, main.rs; Claude 2.1.299 --help and binary strings; the Codex 0.163.0-alpha.10.2 stable schema, generated and then deleted).

But I count 7 high-severity holes. In each one, a "Work freely" or "Ask me" session ends up with Full-equivalent power, or the forgeable mailbox gains authority:
- Playwright tools are auto-approved.
- The webview can set the command lists that become allow rules.
- Build/test on for Claude equals running any code as Ben.
- "Allow for this chat" can widen a session past its level.
- Wake-on-mail lets any sender reach Full-access sessions.
- At Full, user and project settings can switch billing or redirect traffic.
- At Full, -p skips the workspace trust dialog.

Four claims are wrong or out of date:
- `codex app-server` has no --ignore-user-config (checked in its --help).
- Claude's default --system-prompt-snapshot freezes the session preamble.
- The wake watcher's inbox call uses the wrong field names (mailbox.rs:341).
- Measured memory is about 2x the estimate. The 4 claude.exe 2.1.299 processes running now use 627–732 MB private each; Codex uses 305 MB.

Scope: the 20 agent-day figure is an estimate, and I expect 30–40 once the gates are run. For 0.4.0, ship:
- sessions;
- access enforcement (Read only, Work freely, Full, plus Codex Ask me);
- unified chat;
- Playwright with a tool allowlist;
- retiring Classic.

Move these to 0.4.1: wake-on-mail, schedules, the Claude Ask-me fallbacks and the CodexExecDriver. Move Windows-MCP to 0.5. Also cut the test plan to match Ben's "happy path" rule.

Conflict of interest: I am a Claude model reviewing a Claude-written design that divides work between Claude and Codex. The calls above rest on verified code, help text and schema, not on preference.

Process note: I wrote claude-help.txt and store.js into the shared scratchpad, and both writes overwrite. If another agent had files with those names, they were replaced. I deleted both schema folders I generated (cxs-stable, cxs2). I made no repo edits, model calls or mailbox posts.

## Findings

### 1. [high] §8 Playwright MCP; §4.1 Work freely allowlist (mcp__playwright__*), Codex default_tools_approval_mode='approve'

**Problem.** At Work freely, Playwright MCP is on by default and every tool is pre-approved. MCP servers are separate processes, so they sit outside Claude's --restricted limit (which covers only the built-in file tools; verified in --help) and, by inference, outside Codex's sandbox.

A prompt-injected page can use the browser to:
- open file:// URLs for ~/.claude/.credentials.json, ~/.codex/auth.json or the board;
- upload local files;
- run page JavaScript;
- send the data out through navigation.

This breaks the Work freely confinement the design claims. It also contradicts the roadmap's own rule that Work freely stays inside the project. The design only notes that origin lists are not a boundary.

**Fix.** Below Full, never allow `mcp__playwright__*`.
- Allow a named subset instead (navigate, snapshot, click, type, wait, screenshot): Claude `--allowedTools mcp__playwright__browser_navigate,…`, Codex `mcp_servers.playwright.enabled_tools=[…]`.
- Exclude evaluate, run-code, file-upload and file:// access. Verify the tool list and that file: navigation is refused in V5, using the pinned 0.0.83.
- Make Playwright opt-in per project at Work freely rather than on by default.

### 2. [high] §4.4 access_policy_set; §11.3 Contract B

**Problem.** `access_policy_set` takes `commands` and `computerUse` from the webview. Only a level raise or turning a deploy/release/marketplace toggle on triggers the native MessageBox.

Adding `powershell`, `cmd`, `node -e` or `python -c` to the build list, or turning on Windows-MCP, needs no confirm. A markdown/XSS escape in any agent's output, even a Read-only agent's, can therefore turn every Work-freely Claude session into one that runs any code, because `Bash(<cmd>:*)` is generated from that list.

**Fix.** Treat any change that grows capability as a raise and put it behind the native confirm:
- an added or changed command pattern;
- Playwright or Windows-MCP turned on;
- any toggle turned on;
- a level raised.
The confirm shows the exact command strings. Validate patterns natively: refuse shells, interpreters with -c/-e/--eval, `cmd`, `powershell`, `bash`, `sh` and bare `node`/`python`. The new streaming node must use textContent only, never innerHTML.

### 3. [high] §4.3 toggles; §4.4 'Why agents can't edit it'; §6 git_status_light

**Problem.** With Build/test on, Claude at Work freely is Full access in practice. It can Edit package.json scripts, tests or build.rs, then run the allowed `npm test`, `node --test` or `buildlock.py -- cargo` without a sandbox. That defeats:
- the deploy and release denies (`git push` can run from inside a test);
- policy protection;
- the claim that only Full agents can edit access.json.

Cross-agent planting makes it worse. A sandboxed Codex Work-freely agent can write build.rs, a test, or `.git/config` (for example `core.fsmonitor`). The next process that runs without a sandbox then executes it: Claude's build commands, Ben, or CodaClauda's new `git status` in git_status_light, which runs fsmonitor.

**Fix.** Label Claude Build-on as "runs any code as you" in Projects and in the raise confirm, and drop the claim that deploy/release-off is enforced while build is on. Recommend Codex for build/test at Work freely.

Harden every git command CodaClauda runs in a project:
- `-c core.fsmonitor= -c core.hooksPath=NUL -c core.pager=cat -c diff.external=`;
- `--no-optional-locks`;
- `GIT_CONFIG_NOSYSTEM=1`.
Add an A2 check that Codex workspace-write cannot write `.git/config` on Windows.

### 4. [high] §4.5 'Allow for this chat'

**Problem.** Claude's updatedPermissions types include `setMode` and `addDirectories` with a `destination` field (verified in the zod schema inside claude.exe 2.1.299). Filtering only to destination `session` still lets one click:
- switch Ask me to acceptEdits;
- add the board folder to the --restricted limit;
- accept broad prefix rules such as `Bash(git:*)`. At Ask me no deny rules are added for off toggles, so that also allows `git push`.

Codex permissions requests can ask for special path `{kind:'root'}` write access (verified in the stable schema), and `acceptForSession` caches it.

**Fix.** For Claude, keep only `addRules` whose rule exactly matches the requested tool and input. Drop setMode, addDirectories, removeRules and replaceRules. Still pass `--disallowedTools` for off toggles at Ask me.

For Codex, refuse or narrow `permissions` grants that cover root, the home folder, the board, CODEX_HOME or ~/.claude. Show every path in the card, and offer only "once" for any grant outside the project.

### 5. [high] §5 Wake on mail; T16

**Problem.** Wake-on-mail turns the forgeable mailbox into a way to borrow another session's authority.
- Any mailbox writer can wake an owned Full-access session in another project: desktop chats, the CLI, and v1 request MCPs, which may post with any non-owner `from` (mcp.rs:384-399).
- The hop cap is evaded by posting fresh `question`s with no reply_to (mailbox.rs:255 allows that).
- Ping-pong detection keys on `from`, which can be faked, and misses 3-agent cycles.
- There is no global daily cap, the Claude dollar cap is off by default, and per-session per_day goes up to 200 with global per_hour up to 60.
- Approvals-view replies are owner posts, so they also reset hop counts.

**Fix.** Add a sender allowlist per session. The default is owner-composer posts only, and agents are added explicitly by Ben.
- Never wake a Full session from a non-owner sender unless Ben opts in for that pair.
- Add a global daily wake cap (for example 40).
- Turn the per-wake Claude budget cap on by default.
- Pause wakes when `account/rateLimits/read` shows plan usage above a threshold.
- Do not count Approvals-view auto-replies as owner actions.
- Count loops per recipient over all senders, not per pair.

### 6. [high] §3 launch env; §4.1 Codex launch; T6

**Problem.** T6 says "None known", and that is wrong.
- The design drops `-c forced_login_method="chatgpt"`, which v1 sets (adapters.rs:431).
- `codex app-server --help` has no --ignore-user-config, so the user's config.toml loads at every level. That includes model_provider, base URLs, `notify` (an external program run after each turn) and MCP servers.
- At Full, Claude loads user and project settings. Their `env` or `apiKeyHelper` can set ANTHROPIC_API_KEY or ANTHROPIC_BASE_URL, which switches billing or sends the OAuth token to another host. The environment allowlist cannot see this.

**Fix.** Keep `forced_login_method="chatgpt"`, `model_provider="openai"` and `notify=[]` as -c overrides at every level, and disable each user-config MCP server by name.

At launch, verify and abort on mismatch:
- `account/read` shows type chatgpt;
- `config/read` shows `forced_login_method` and `model_provider` as expected;
- Claude `system/init.apiKeySource` is empty or none. The field exists in the init schema.

At Full, pass `--setting-sources user` unless Ben has trusted that repo in CodaClauda.

### 7. [high] §4.1 Full access; T4

**Problem.** "At Full, project settings and hooks load, as in Claude Code itself" is not true for -p. Claude's --help says the workspace trust dialog is skipped in non-interactive mode, and settings files that fail validation are silently ignored.

So with a repo cloned through the design's "Clone…" option and set to Full (the bulk "Set access" menu makes that easy), the repo's .claude/settings.json hooks and env run at session start with no prompt. Codex is safer, because hooks need persisted trust (`--dangerously-bypass-hook-trust` exists).

**Fix.** At Full, exclude the project and local setting sources (`--setting-sources user`) until Ben ticks "Trust this repo's Claude settings". That confirm lists the repo's hooks, its env keys (names only) and its MCP servers. Re-ask whenever .claude/settings*.json changes, using a stored hash.

### 8. [medium] §4.3 session preamble; §4.6; §5 notices

**Problem.** `--system-prompt-snapshot` is on by default (Claude --help). The system prompt, `--append-system-prompt` included, is recorded on the first request, and every later request and resume sends that record as-is until compaction.

So after Ben lowers or raises access or changes toggles, the model is still told the old level and command list. "Unread notices in the next turn's preamble" cannot work either.

**Fix.** Keep the appended system prompt static (rules only). Put the level, toggles, allowed commands and notice counts in a short CodaClauda prefix on each user turn and in the `context` tool. Or pass `--system-prompt-snapshot off`, at a prompt-cache cost. Check this in S1.

### 9. [medium] §2.5 step 3 (address per session); §5 watcher; §11.5 (0.4.1 polling move)

**Problem.** Every new chat registers a new mailbox address, and addresses are never removed. The UI's refreshMail starts one `claudacoda-cli mailbox-inbox` process per registered address every 6 s, all in parallel (store.js:114-127).
- Each call takes the exclusive mailbox.lock and parses the whole mailbox.json (mailbox.rs:152-190).
- The new watcher adds one more locked read per owned address every 5 s.
- After about 30 chats that is around 30 CLI processes every 6 s, on a PC that is already short of RAM.

The watcher call also uses `{address, after}`. The real fields are `addr` and `since`, and `fields()` refuses unknown keys (mailbox.rs:341).

**Fix.** Do this in 0.4.0, not 0.4.1:
- read all owned addresses in one in-process mailbox transaction;
- leave session addresses out of the UI's per-address CLI loop and feed them through session_watch;
- or use one address per provider and project, reused across chats.
Also fix the field names to addr and since.

### 10. [medium] §2.6 memory budget

**Problem.** The estimates are low, and the code would enforce a different metric.
- Measured now: the 4 running claude.exe 2.1.299 processes use 627–732 MB private each (251–363 MB working set), and codex.exe uses 305 MB private. The design estimates 200–400 MB and 80–200 MB, but enforces on PrivateUsage.
- So 3 live Claude sessions are about 2.1 GB before any browser.
- A Playwright browser opened during a turn skips admission, and memory reaping never interrupts a running turn.
- Commit headroom (16.1 GB free of 59.4 GB) is a tighter limit than free physical memory (12.1 GB), and the floor checks only ullAvailPhys.
- During development, both desktop apps, cargo builds and Python jobs (15 GB private now) run at the same time.

**Fix.** Defaults:
- 2 live provider processes;
- at most 1 Playwright browser at a time, counted in admission;
- admit only when both available physical memory and commit headroom (ullAvailPageFile) clear the floor.
Record private bytes (not working set) in A7, and set the defaults from that measurement.

### 11. [medium] §11.1 update_storage.rs; §2.5 App exit

**Problem.** The design under-specifies how the updater and sessions interact.
- The update helper takes the exclusive session-runtime.lock and state.lock while the app is still running, before `wait_parent` (update_helper.rs:573, then wait_parent).
- sessions.json is not covered by that guard, so a wake or scheduler tick can start a turn after the preflight.
- If agent-mcp holds a shared runtime lease, as session_mcp does (session_mcp.rs:322), every idle live session blocks updates, with the misleading message "Disconnect the CodaClauda MCP server".
- If it holds no lease, the installer may try to replace a claudacoda-cli.exe that is still running.

**Fix.** Add a host "draining" state before preflight: stop wake and the scheduler, refuse new turns, and close all live processes. Then have the preflight read sessions.json under sessions.lock. State explicitly whether agent-mcp takes the runtime lease, and change the message to match.

### 12. [medium] §6 'Open in terminal'

**Problem.** Opening a session in a terminal drops enforcement.
- `claude.exe --resume <id>` in interactive mode loads user and project settings, with no --restricted, --tools or --permission-mode.
- `codex.exe resume <id>` without `--no-daemon` attaches to the desktop app's shared server. Help says --no-daemon means "Run without the shared background server, even if it is already running". Sandbox and approval then come from config defaults.
- "Same environment" passes the agent capability along.
- Nothing stops CodaClauda from resuming the same session while the terminal still has it.

**Fix.** Launch with the level's flags:
- Claude: the same --restricted, --tools, --permission-mode and --strict-mcp-config.
- Codex: `--no-daemon -s <mode> -a <policy>`, which top-level codex and `resume` both accept.
Remove CODACLAUDA_AGENT_CAPABILITY from that environment. Mark the session `external` so CodaClauda refuses sends until Ben confirms the terminal is closed.

### 13. [medium] §4.1 Read only / §4.4; T1

**Problem.** Codex reads are not confined. In the stable 0.163 schema, the readOnly and workspaceWrite sandbox policies have no readable-roots field (verified).

So Codex at Read only, Ask me or Work freely can read:
- ~/.claude/.credentials.json;
- other projects;
- the board's events.jsonl transcripts;
- the whole mailbox.
At Work freely, web_search (and Playwright, if allowed) is a way to send it out. "Read only is enforceable on both providers" holds for writes only.

**Fix.** Say this in the Projects honesty line. Disable Codex web_search at Work freely unless Ben turns network on for that project. Track the experimental `permissions` profiles, which may restrict reads, for 0.4.1.

### 14. [medium] §4.1 Claude common flags; T4

**Problem.** The design drops `--disable-slash-commands`, which v1 passes (adapters.rs:406) and which "Disable[s] all skills". --restricted ignores settings files, not skill folders.

A repo's `.claude/skills/*/SKILL.md` can declare `allowed-tools`. By inference, that grants Bash patterns while the skill is active, which is a way around the Work-freely command allowlist.

**Fix.** Keep `--disable-slash-commands` below Full. In S1, confirm that a project skill with `allowed-tools: Bash(*)` cannot run a command outside the allowlist.

### 15. [medium] §8 Windows-MCP; T9

**Problem.** Windows-MCP drives the real mouse and keyboard. It can click CodaClauda's own inline approval cards and the native MessageBox raise confirm, which approves other sessions' requests and raises other projects. That breaks the "webview can't click it" defence (T2).
- Ctrl+Alt+End is taken by Remote Desktop clients.
- `uvx --from windows-mcp==0.8.8` pins only the top-level package and resolves transitive dependencies at run time, which contradicts T8.
- The runtime is not installed, so 0.4.0 cannot accept it.

**Fix.** Move Windows-MCP (wiring, hotkey, stop window) to 0.5. If it stays, then while desktop control is live:
- refuse approval_answer and policy raises;
- use a stop hotkey that does not clash with RDP;
- run only from a hash-locked `uv tool install` environment, never from uvx resolution.

### 16. [medium] §11.1 tracks; §11 claims

**Problem.** The ownership split conflicts with the agreed roles (memory: Claude owns src-tauri/src/** and UI; Codex owns installers and lean tests).
- update_storage.rs (in src-tauri/src) goes to Codex.
- tools_install.rs, an npm installer, goes to Claude.
- The policy write path is split: core `policy::set` (Codex) and access_policy.rs with the confirm (Claude). Neither owns the tamper digest in sessions.json.
- Schedules state is split between registry.rs (Codex) and scheduler.rs (Claude).
- The resource claims (coord-core-sessions, chat-ui, src-tauri-main) do not cover src-tauri/Cargo.toml, tauri.conf.json, adapters.rs, ui/dev/mock.js or DESIGN.md, which both tracks touch.
- Giving the security-critical engine to Codex is a new allocation that Ben has not approved.

**Fix.** Give each file exactly one owner. Put the policy writer, its digest and the confirm in one track, and the schedules state and timer in one track. Add claims for every shared file. Ask Ben to approve the engine split explicitly in chat.

### 17. [medium] §1 scope; §11.5 milestones; §12 test plan

**Problem.** 0.4.0 carries too much. These items add risk without serving "stop needing the desktop apps":
- wake-on-mail, which needs D1 and is the main loop, cost and injection risk;
- schedules, which run unattended with no tray;
- the CodexExecDriver, a second driver. `exec resume` rejects the existing builder's --sandbox, -C and --color, and -c on resume is unverified;
- the Claude Ask-me fallbacks A and B;
- Windows-MCP.
The test plan has about 35 recorded items (V1–V7, S1–S5, P1–P10, A1–A13), against Ben's recorded "happy path, no overtesting" rule. The 20 agent-days is an estimate, and I expect 30–40.

**Fix.** 0.4.0: sessions, enforced access (Read only, Work freely, Full, plus Codex Ask me), unified chat, Playwright with an allowlist, retire Classic.
- If the Codex protocol gate fails, fail closed with a notice instead of using an exec fallback.
- 0.4.1: wake, schedules, Claude Ask me and the exec fallback. 0.5: Windows-MCP.
- Tests: keep the golden argv/env/verify tests, S1–S4, A1, A2 and A7. Fold P1–P10 into one preview pass.

### 18. [low] §2.2/§2.5 Claude persistent mode; §5/§7 caps

**Problem.** `--max-turns` and `--max-budget-usd` are launch flags for the whole process.
- A wake or continue-session schedule sent into a live, owner-launched process gets no cap.
- A process launched for an unattended run and then reused for Ben's turns keeps that cap.
- Whether `total_cost_usd` in `result` adds up across one process's turns is unverified. If it does, summing it per turn double-counts.

**Fix.** Always start a fresh process for unattended turns, and close it afterwards. Compute usage and cost as deltas, and check in S1 whether `result` totals add up across turns.

### 19. [low] §2.2 Codex client; §2.5 resume

**Problem.** `thread/resume` without `excludeTurns:true` returns the whole thread history. The stable schema marks full hydration as deprecated. live_codex's reader stops at 1 MiB per line, and the design sets no line policy for codex_rpc, so long threads can fail to resume. A large `turn/diff/updated` has the same problem.

**Fix.** Send `excludeTurns:true` on resume. Give codex_rpc a cap of about 8 MiB per line. Oversized notifications are dropped with a marker, and only an oversized response to a pending call fails the session.

### 20. [low] §4.1 Codex below Full; §2.6; A1/A2

**Problem.** Several Codex Windows sandbox assumptions are unchecked.
- CODEX_HOME has .sandbox-secrets, which suggests commands run as separate sandbox users. Processes started under another logon may fall outside CodaClauda's job object, so Stop, KILL_ON_JOB_CLOSE and memory sampling could miss them.
- No check confirms that `networkAccess:false` actually blocks network on Windows.
- Network off also breaks cargo and npm dependency downloads at Work freely, which the toggle table does not mention.

**Fix.** In A1 and A2, start a long sandboxed command and confirm Stop and app exit kill it. Confirm `curl` and `git push` fail with network off. Say in the UI that builds needing downloads need the network toggle.

### 21. [low] §8 MCP config; §3; §2.3

**Problem.** The capability's handling is contradictory.
- §3 says the capability is only in the environment block.
- §8's Claude MCP JSON includes `env:{CODACLAUDA_AGENT_CAPABILITY}` on disk.
- A crash between writing the file and system/init leaves mcp-*.json behind, and §2.5 recovery does not sweep it.
- The capability is also inherited by every shell command and by the Playwright and Windows-MCP children.

**Fix.** Rely on environment inheritance, or `${CODACLAUDA_AGENT_CAPABILITY}` expansion (verify in V1), so the value never touches disk. Delete stale `sessions/*/mcp-*.json` in SessionManager::open. For Codex, add the variable to `shell_environment_policy.exclude`.
