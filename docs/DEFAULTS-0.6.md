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

## Changed in 0.6 (16)

| Setting | 0.6 default (0.5) | Where |
|---|---|---|
| Agents can start teammates in my projects (owner standing switch) | On for every linked project without its own entry (off, per project only) | `src-tauri/src/session_host/team.rs:75` |
| Agent-started sessions working at once, per project | Unlimited (8) | `team.rs:75` |
| A start request may name a real folder | A folder on the Desktop, or inside a linked project, registers automatically: Full if it is the owner's own (under the user profile, or its origin owner is the linked GitHub user), otherwise Read. It is capped by any linked project around it (only linked projects before) | `team.rs:329` |
| Answers from codaclauda-team | Every question or notice gets "received" first, then "started" or "refused", with the code and the exact setting that fixes it (silence on a notice, on a storage failure, and on the TEAM_SWITCH_OFF wake refusal) | `team.rs:707`, `wake.rs:297` |
| Inbox polling | Team inbox every 5 s; wake inboxes every 10 s (every 60 s) | `wake.rs:45` |
| Wake loop guard | On, Notify, 60 per pair per hour. Waking never pauses; the owner gets one notice per pair per hour. 0.5 files migrate to Notify at no less than 60 (On, pause at 20) | `wake.rs:71` |
| Delivery answer when posting | `post` tells the sender `received` (with the pickup time), `app_not_running` (with the fix), or `passive`. It reads the host heartbeat the app writes every 5 s (nothing) | `crates/coord-core/src/heartbeat.rs`, `mailbox.rs` |
| codaclauda-team address | Exists from the first post, before the app first runs (a post failed until the app had run) | `crates/coord-core/src/mailbox.rs:272` |
| `--kind reply` without `--reply-to` | Answers the newest retained message from the recipient (refused) | `mailbox.rs:278` |
| Credential pattern for sk-, gh*_ and Bearer | Must start a word, so "task-" and "desk-" pass. Real keys are still refused (matched inside words) | `crates/coord-core/src/secrets.rs:64` |
| Codex: use my earned weekly resets | On. One reset is redeemed per limit episode, under the owner's standing toggle (did not exist) | `src-tauri/src/session_host/usage.rs:40` |
| Codex: continue on ChatGPT credits | On, until the credits or the owner's spend cap run out (did not exist; the turn just failed) | `usage.rs:40` |
| Claude: continue on usage credits | On, when they are enabled at claude.ai (did not exist) | `usage.rs:40` |
| A turn stopped by a usage limit | Explained in the chat and sent again once: now if a reset or credits cover it, else at the reported reset (error only) | `usage.rs:593` |
| Phone push switches (turn finished / turn failed) | Both on, so pasting a topic URL is the only step. Nothing is posted without the owner's URL (both off) | `src-tauri/src/session_host/notify.rs:24` |
| Continue a conversation found on this PC | Running > On this PC > Continue in CodaClauda. It resumes that exact conversation with wake on, at the project's current access (not available) | `external.rs:344`, `ui/app/views/running.js:209` |

Already automatic before 0.6, and unchanged:

- Agents at once: Unlimited (`limits.rs:62`).
- Board requests at once: Unlimited (`crates/coord-core/src/policy.rs:92`).
- Grant counts: unlimited (`policy.rs:27`).
- Wake: on globally (`wake.rs:164`), and on for every new session (`wake.rs:699`).
- Toasts and sound: on (`ui/app/store.js:45`).

## Kept (19)

| Boundary | What still waits on the owner | Why | Where |
|---|---|---|---|
| Owner-only settings | Every setting above is a desktop command from the owner's window, or an owner CLI op. A scoped worker holding a capability cannot call owner ops, and no agent tool reaches team, wake, usage or limits | owner-only authority | `src-tauri/src/main.rs` invoke list; `crates/coord-core/src/lib.rs` owner ops |
| Grants (board lane) | Only the owner creates them. Live chat grants are question-only, with no delegation or hops | owner-only authority, scope | `docs/DESIGN.md` 0.3; `crates/coord-core/src/lib.rs` |
| Grant run time and expiry | 24 h per run, 7 days to expire; the counts are unlimited. The owner can set either to Unlimited in Settings > Limits | revocable (bounds stale authority) | `policy.rs:27` |
| Project access level | Full for the owner's own folders and repos, Read otherwise. Only the owner changes it in Projects > Access | scope, no self-escalation | `ui/app/access.js:44` |
| Teammates and continued chats | They start at the project's current level, never higher. A folder that is not the owner's own registers at Read, and it inherits a parent project's off switch | no self-escalation, scope | `team.rs:329`, `team.rs:493`, `external.rs:344` |
| Per-project Teammates override | The owner can still turn one project off | revocable | `team.rs` (project entry) |
| Owner MCP servers | None by default; passed to Full sessions only; installed by the owner (presets are text) | scope; nothing downloaded or run for the owner | `src-tauri/src/session_host/mcp.rs:3` |
| Provider sign-in | Subscription logins only. ANTHROPIC_API_KEY, OPENAI_API_KEY and CODEX_API_KEY are stripped from the environment. Credential files (`~/.codex/auth.json`, `~/.claude/.credentials.json`, *token*, *.key) are never read | no credential copying, spending | `src-tauri/src/session_host.rs:79`, `src-tauri/src/session_policy.rs:117` |
| Usage switches | One global owner setting, unreachable from agent tools. An unreadable `usage.json` turns credits and resets off until the owner saves | spending | `usage.rs:96` |
| Mail is information | Wake turns frame mail as untrusted. A sender name proves nothing, and a message cannot widen scope or access | owner-only authority | `wake.rs:438` |
| Credential filter on posts | Keys, tokens, JWTs, AWS keys, private keys, and the `token:` / `password=` / `authorization:` forms are still refused (see R1) | no credential copying | `mailbox.rs:192` |
| Team receipts | Each outcome is saved before any session work and before the reply. The message is acknowledged after that, so a restart never starts a teammate twice | receipts | `team.rs` `process` |
| Wake receipts | Mail is acknowledged only after durable turn admission | receipts | `wake.rs` |
| Revocation | Grants revoke; wake has per-session and global switches; team has standing and per-project switches; usage has a switch per provider | revocable | as above |
| Continue in CodaClauda | One owner click with a warning. No hidden IPC into the other app, and the transcript is never edited; the provider's own resume is used | no hidden IPC, no transcript editing | `running.js:209`, `external.rs` |
| Read sessions | A read-only sandbox, so a Read session cannot write or post (see R6) | scope | `session_policy.rs` |
| Claude session isolation | `--disable-slash-commands` and `--setting-sources ""`, so a session cannot change its own policy | no self-escalation | `session_policy.rs:83` |
| Phone push destination | Nothing is sent until the owner saves an https topic URL | disclosure the owner chooses | `notify.rs` |
| Update install | Download and install run only on the owner's action, with browser approval | owner-only authority (runs downloaded code) | `src-tauri/src/updates.rs` |

## Recommendations (not changed)

1. **R1. Mailbox keyword filter** (`mailbox.rs:192`). It refuses prose like
   "the token is ready", "secret: none" or "authorization: granted". It could
   refuse a `token|secret|password|authorization` value only when the value
   looks like a credential: 16 or more characters mixing letters and digits, or
   a known prefix. This is the credential boundary, so Ben should decide.
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
   session address afterwards reads `passive`, not `app_not_running`
   (codaclauda-team still reads `app_not_running`). A "stopped" marker would
   fix this, but it changes the H1 contract.
8. **R8. Browser control** stays refused for the session flag
   (`session_host.rs:97`). The owner's Playwright MCP preset at Full access is
   the supported route.
