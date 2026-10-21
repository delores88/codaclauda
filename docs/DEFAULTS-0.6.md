# CodaClauda 0.6 defaults audit

Ben asked for 0.6 to make CodaClauda less strict. This audit lists every default
in this tree that waited on an owner action. Each row is marked:

- **CHANGED**: the default is now on or automatic in 0.6.
- **KEEP**: a real safety boundary that stays as it is. The reason is one of:
  owner-only authority, project scope, no self-escalation, no credential
  copying, revocable, receipts, or spending.

Bigger changes that need Ben's call are listed under Recommendations at the
end. They were not made.

The audit covered the settings, team, wake, limits, policy, access, MCP, usage,
schedule and notify code, plus the board crate. "Usage" replaces the API-key
fallback (H7) from the first 0.6 plan: Ben has ChatGPT credits, not an API key,
so no API profile, key handling or sign-in switching was built.

## Changed in 0.6 (17)

| Setting | 0.6 default (0.5) | Where |
|---|---|---|
| Agents can start teammates in my projects (owner standing switch) | On for every linked project without its own entry (off, per project only) | `src-tauri/src/session_host/team.rs:75` |
| Agent-started sessions working at once, per project | Unlimited (8) | `team.rs:75` |
| A start request may name a real folder | A real folder inside a linked project registers automatically: its real path must lie under the linked project's real path with no `..`, link, junction or reparse point in between (existing alone is not enough; the 0.6 draft also took any Desktop folder). Full if it is the owner's own (under the user profile, or its origin owner is the linked GitHub user), otherwise Read. It is capped by the linked project around it and by a Read saved for its repo, and is revoked at the next start, wake or dispatch once that project is unlinked (only linked projects before) | `team.rs` `under_root`, `locate`, `around` |
| Answers from codaclauda-team | Every start request gets `queued` (saved, nothing started), then `admitted` at provider dispatch (provider receipt and execution remain separate), then one outcome: `completed`, `failed`, `refused` or `cancelled`, each with its code and the exact setting that fixes it. A queued request can be cancelled by its sender or the owner; one that waited more than 24 h for the app is refused, never launched late. A notice never starts anything and is answered `TEAM_NOTICE_PASSIVE`. A storage failure is answered too, and shown in Settings > Team and the heartbeat (silence on a notice, on a storage failure, and on the TEAM_SWITCH_OFF wake refusal) | `team.rs` `process`, `track`, `wake.rs` |
| Inbox polling | Team inbox every 5 s; wake inboxes every 10 s (every 60 s) | `wake.rs:45` |
| Wake loop guard | On, Notify, 60 per pair per hour. Waking never pauses; the owner gets one notice per pair per hour, sees each pair's count for the last hour in Settings > Team and can pause one pair until resuming it. Only an absent guard receives this default. Every saved 0.5 guard keeps its on/off and count with Pause behavior, including Pause at 20; a saved mode is kept (On, pause at 20) | `wake.rs` `LoopGuard`, `pair_view` |
| Delivery answer when posting | `post` reports the durable board receipt (`saved`, always) and the app's host lease for that exact board: `available` (a heartbeat under 30 s old that names this board, from an installation whose binding names this board), `unavailable` (none, stale, or another board or installation) or `unknown` (unreadable or malformed, or the app could not read its team inbox), with the error; plus who reads the address and, for a start request, its queued state and how to cancel it. Posting never starts anything (nothing) | `crates/coord-core/src/heartbeat.rs`, `mailbox.rs` |
| codaclauda-team address | Exists from the first post, before the app first runs (a post failed until the app had run) | `crates/coord-core/src/mailbox.rs:272` |
| `--kind reply` without `--reply-to` | Answers the one open question or notice from the recipient that the sender has not answered; with none or several open it is refused, naming `--reply-to` and the candidate ids. A retry with the same id is idempotent (refused) | `mailbox.rs` `save_post` |
| Mailbox refusal of sk-, gh*_ and Bearer | A prefix right after a letter or digit ("task-", "desk-", "laughs_", "flagbearer") is an ordinary word unless its value mixes upper and lower case and digits, so a glued real key is still refused. Stream and file redaction is unchanged from 0.5 and still matches keys inside words (refused) | `crates/coord-core/src/secrets.rs` `mailbox_credential` |
| Mailbox keyword filter (was R1) | Prose such as "the token is ready", "secret: none" or "authorization: granted" is saved. Assignments (`token=`), quoted `"token": value` pairs and `token:` / `password is` values that look like a credential (a key prefix, a digit in 4+ characters, 16+ mixed-case characters) are still refused (refused) | `secrets.rs` `mailbox_credential` |
| Codex: use my earned weekly resets | On. At most one reset is redeemed per limit episode per account, and only when Codex reports both the account id and `availableCount` above zero. The episode is keyed by a hash of the account id (the raw id is never written) and saved in `usage-resets.json` under a file lock before the consume call, so concurrent sessions share it and a lost reply retries only the same key (did not exist) | `src-tauri/src/session_host/usage.rs` `ResetBook` |
| Codex: continue on ChatGPT credits | On, only while Codex explicitly reports credits left and `spendControlReached: false`; an unreported field is unknown, never a yes. Per-turn cost is shown as Codex's estimate in credit units, never money (did not exist; the turn just failed) | `usage.rs` `codex_credit_check` |
| Claude: continue on usage credits | On, when they are enabled at claude.ai. A rate-limit state of `rejected` with no usable overage holds the turn before sending (did not exist) | `usage.rs` `claude_overage` |
| A turn at a usage limit | A turn the gate refuses before anything is sent is **held**: it keeps its ledger entry and turn id, later turns wait behind it, Stop or close cancels it, and a restart keeps it held. It is retried once by itself, only at a provider-reported reset that is in the future and inside its window; otherwise it waits for Try now or a usage switch turned on. A turn already sent is **never replayed**: the chat says it stopped at the usage limit and offers Continue, a new owner turn that names it (once). Timed schedule runs are not held: they report not sent and run at their next time (error only) | `usage.rs` `hold_turn`, `release_held`, `continue_item` |
| Phone push switches (turn finished / turn failed) | Both on, so pasting a topic URL is the only step. Nothing is posted without the owner's URL (both off) | `src-tauri/src/session_host/notify.rs:24` |
| Continue a conversation found on this PC | Running > On this PC > Continue as a copy. It starts a CodaClauda chat holding a separate, labeled copy of the conversation so far, with wake on, at the project's current access; the original stays untouched in its own app, which is not woken. Continuing it in place is refused with `OWNERSHIP_UNKNOWN`, because a conversation file or process snapshot does not establish that no other app still writes it (not available) | `external.rs` `adopt`, `ownership_unknown`, `adopt_copy`; `ui/app/views/running.js` |

Already automatic before 0.6, and unchanged:

- Agents at once: Unlimited (`limits.rs:62`).
- Board requests at once: Unlimited (`crates/coord-core/src/policy.rs:92`).
- Grant counts: unlimited (`policy.rs:27`).
- Wake: on globally (`wake.rs:164`), and on for every new session (`wake.rs:699`).
- Toasts and sound: on (`ui/app/store.js:45`).

## Kept (22)

| Boundary | What still waits on the owner | Why | Where |
|---|---|---|---|
| Owner-only settings | Every setting above is a desktop command from the owner's window, or an owner CLI op. A scoped worker holding a capability cannot call owner ops, and no agent tool reaches team, wake, usage or limits | owner-only authority | `src-tauri/src/main.rs` invoke list; `crates/coord-core/src/lib.rs` owner ops |
| Grants (board lane) | Only the owner creates them. Live chat grants are question-only, with no delegation or hops | owner-only authority, scope | `docs/DESIGN.md` 0.3; `crates/coord-core/src/lib.rs` |
| Grant run time and expiry | 24 h per run, 7 days to expire; the counts are unlimited. The owner can set either to Unlimited in Settings > Limits | revocable (bounds stale authority) | `policy.rs:27` |
| Project access level | Full for the owner's own folders and repos, Read otherwise. Only the owner changes it in Projects > Access | scope, no self-escalation | `ui/app/access.js:44` |
| Teammates and continued chats | They start at the project's current level, never higher. A folder that is not the owner's own registers at Read, only under a linked project reached without links, and it inherits that project's off switch and Read level. Switch, access, linkage and path are rechecked at admission, dispatch and every wake | no self-escalation, scope | `team.rs` `plan`, `check_admission`, `external.rs:344` |
| Per-project Teammates override | The owner can still turn one project off | revocable | `team.rs` (project entry) |
| Owner MCP servers | None by default; passed to Full sessions only; installed by the owner (presets are text) | scope; nothing downloaded or run for the owner | `src-tauri/src/session_host/mcp.rs:3` |
| Provider sign-in | Subscription logins only. ANTHROPIC_API_KEY, OPENAI_API_KEY and CODEX_API_KEY are stripped from the environment. Credential files (`~/.codex/auth.json`, `~/.claude/.credentials.json`, *token*, *.key) are never read | no credential copying, spending | `src-tauri/src/session_host.rs:79`, `src-tauri/src/session_policy.rs:117` |
| Usage switches | One global owner setting for CodaClauda-owned sessions only, unreachable from agent tools; Off is an admission policy. An unreadable `usage.json` turns credits and resets off until the owner saves | spending | `usage.rs` `read_settings` |
| Unreported plan fields | A missing `ordinaryUsageAllowed`, credit balance, spend-control flag, reset count or account id stays unknown: the UI says billing is not reported. An unknown-state admission can still result in provider charges; Off cannot guarantee a hard spending cap without a provider per-turn opt-out. No earned reset is redeemed without the required account and fresh eligibility evidence. Try now rechecks the current usage policy | spending, receipts | `usage.rs` `codex_state` |
| Mail is information | Wake turns frame mail as untrusted. A sender name proves nothing, and a message cannot widen scope or access | owner-only authority | `wake.rs:438` |
| Credential filter on posts | Keys, bearer tokens, JWTs, AWS keys, private keys, pairing codes and credential assignments are still refused, with a fixed message that never echoes the input | no credential copying | `secrets.rs` `mailbox_credential` |
| Stream and file redaction | Key prefixes are matched wherever they appear, including inside words and across read chunks; over-redaction is accepted, a leak is not | no credential copying | `secrets.rs` `redact`, `redact_file`, `WriteScan` |
| Team receipts | Each state of a request is saved before its reply; the message is acknowledged once the request is launching or terminal, and the saved state answers retries, so a restart never starts a teammate twice and a cancelled or refused request never launches | receipts | `team.rs` `process` |
| Wake receipts | Mail is acknowledged only after durable turn admission | receipts | `wake.rs` |
| Revocation | Grants revoke; wake has per-session and global switches; team has standing and per-project switches; usage has a switch per provider | revocable | as above |
| Continue as a copy | One owner click with a confirmation. No hidden IPC into the other app, and the transcript is never edited; the provider's own fork is used. Another app's conversation is never continued in place (see Changed) | no hidden IPC, no transcript editing, no automatic adoption | `running.js`, `external.rs` |
| Wake by mail for a Codex desktop chat | Off for every chat until the owner binds it (Running > On this PC). Binding needs a registered board address that is not reserved or a CodaClauda session's, and a Codex thread on this PC inside an unambiguous, currently Full-access linked project that no CodaClauda session writes; all of it is rechecked before each delivery. Read or unverifiable access refuses because queue cannot enforce the external thread sandbox. Delivery runs Codex's own `codex queue` once per batch under the global wake switch, with counts and sender names only, nothing acknowledged, and a saved receipt; no model is started to probe | owner-only authority, scope, receipts, no hidden IPC | `src-tauri/src/session_host/desktop_queue.rs` |
| Read sessions | A read-only sandbox, so a Read session cannot write or post (see R6) | scope | `session_policy.rs` |
| Claude session isolation | `--disable-slash-commands` and `--setting-sources ""`, so a session cannot change its own policy | no self-escalation | `session_policy.rs:83` |
| Phone push destination | Nothing is sent until the owner saves an https topic URL | disclosure the owner chooses | `notify.rs` |
| Update install | Download and install run only on the owner's action, with browser approval | owner-only authority (runs downloaded code) | `src-tauri/src/updates.rs` |

## Recommendations (not changed)

1. **R1. Mailbox keyword filter.** Done after review (Codex 834): see the
   Changed table. Credential shapes are still refused; prose mentions are not.
2. **R2. Claim TTL** of 1 to 120 minutes, default 30 (`mailbox.rs:259`).
   Claims are advisory, so a longer maximum (for example 24 h) would spare
   long builds from re-claiming.
3. **R3. Schedule minimum interval** of 15 minutes (`schedule.rs:25`) and
   **catch-up off** (`schedule.rs:483`). Both are safe to relax, but with
   credits now on by default, a short interval or a burst of catch-ups can draw
   down ChatGPT or Claude credits unattended.
4. **R4. Update check** runs only when chosen (`ui/app/views/settings.js:146`).
   A check at launch would contact the release service on every start, and
   PRIVACY.md says it does not. Install stays owner-approved.
5. **R5. Claude subscription types** are limited to Pro and Max
   (`session_policy.rs:124`). Team and Enterprise logins are refused.
6. **R6. Read teammates cannot reply on the board** by CLI, because their
   sandbox is read-only. Giving Read sessions only the scoped `mailbox_post`
   tool would let them answer without write access.
7. **R7. Heartbeat after a clean exit.** The file is deleted, so a post to a
   session address afterwards reports host `unavailable` with reader `agent`,
   not `session` (codaclauda-team still reads reader `app`). A "stopped" marker
   would fix this, but it changes the H1 contract.
8. **R8. Browser control** stays refused for the session flag
   (`session_host.rs:97`). The owner's Playwright MCP preset at Full access is
   the supported route.
