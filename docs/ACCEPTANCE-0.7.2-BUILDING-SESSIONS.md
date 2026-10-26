# Building sessions and City chat sheet: source acceptance

Date: 2026-10-26. Base: `642fca9` (`codex/codaclauda-0.7.1`).
Prepared in `local/worktrees/072-session`, branch
`codex/codaclauda-0.7.2-session`, for design review and later integration.

## Behavior

Real local buildings on This PC offer Claude and Codex session buttons, an
optional first prompt, and the project's current access. Unavailable providers
are disabled with a reason. The access labels remain **Full access / Read only**,
matching the existing enforced levels. Ghosts retain Clone; Spark and contributor
islands do not offer local session starts.

City and the single-provider Chat dialog share `startProjectSession`, which calls
the existing `sessions.start` / native `session_start` path with the project's
folder and current access. Optional prompts use the existing session send path.
A failed first send keeps the created session and offers a retry to that same
session. Provider discovery is a UI availability hint; native launch still checks
the selected executable and authentication. No backend permission path changed.

The 420px City sheet embeds the existing Chat transcript and composer. It shows
session status, provider and project, streams the existing session events, and
opens the full Chat view with any unsent draft and attachments. Closing the sheet
never calls session stop/close. Mobile uses the full viewport width. Camera
framing includes the sheet as an overlay; City layout, hydration and pan logic
are unchanged. New sessions use the existing NPC walking path to their project.

Agents here opens managed session or mailbox conversations. Metadata-only
external agents retain their existing detail/continue flow; discovery does not
provide their live transcript. Earlier endpoint chats remain readable through
their existing Chat mode.

## Verified evidence

- `cd ui; node --test`: **384 passed, 0 failed**, including provider/project/access
  eligibility, duplicate-start protection, first-send recovery, sheet lifecycle,
  draft handoff, delayed start after navigation, and camera overlay checks.
- Independent source reviews covered the session controls, native-path reuse,
  embedded Chat lifecycle and City integration; no blocking findings remained.
- Headless Chrome browser preview against the bundled synthetic backend checked
  local/ghost/Spark controls, disabled-provider reasons, exact start payloads,
  live mock replies, NPC walking, 420px framing, closing during a turn without
  stopping it, agent and mailbox reopening, full Chat navigation/draft handoff,
  mobile fit, Read only access, failed-send retry, blank prompt, delayed-start
  navigation, and switching to another building. No browser exceptions occurred.
- `git diff --check` passed.

The primary checkout's untracked `local/072-session-evidence/` contains the
browser report and preview scripts, final UI test log, and design-review images:

- `building-panel-new-session.png`
- `chat-popup-open.png`
- `chat-popup-mobile.png`

The mobile sheet and composer fit at 390px. The existing shell top bar still
extends beyond narrow viewports; that separate shell behavior is unchanged.

## Acceptance still required

These are source tests and synthetic browser previews, not installed/native or
real provider acceptance. This work did not launch a real provider session,
build an installer, install, merge into the release branch, push or release.
Design review and an authorized installed workflow check remain release gates.
