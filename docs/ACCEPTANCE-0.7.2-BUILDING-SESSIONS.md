# Building sessions: talk-mode integration pending

**Design correction, 2026-10-26:** the separate sheet described below was rejected
in favor of the existing City `enterTalk()` / `TalkPanel` NPC conversation. Its
component, CSS, embedded Chat refactor and sheet-specific tests have been removed.
The building controls and existing owner start path remain. Agents here now calls
`enterTalk(agent.id)`. New-session conversation integration and fresh acceptance
await the final 0.7.1 talk-mode handoff from `codex-codaclauda-0513`.

At the current `642fca9` base, managed sessions are not resolved by `enterTalk`,
and TalkPanel lacks a session transcript/send mode and a pending-start API.
Those internals are owned by the 0.7.1 work; this branch does not modify them.
The designer has requested the public hook
`enterTalk(id, { pending: { provider, projectId, label } })` from that owner.
Its final handoff will define pending identity, cancellation and staging behavior
before this branch wires the new-session callback to it.
The designer also assigned new-agent drop-in at the project building and Ben's
staging there to 0513; the caller must stay minimal and use that documented hook.
The follow-up requires the building's New session block to remain visible even
when agents are already there or the project is busy. Unavailable providers stay
visible with disabled buttons and reasons. Existing building controls already
have this behavior; their eligibility does not depend on agent counts/activity.
The requested **New session here** talk-header action also awaits a public
callback from 0513. It must use the same project, provider controls and pending
hook for both board agents and managed sessions, with the same visual treatment.
The added occupied/busy regressions pass with **17/17 focused start-control
tests**: controls remain visible, unavailable provider reasons remain visible,
and a second explicit launch succeeds while earlier project sessions run.
No source behavior change was needed for those cases.
Do not integrate this intermediate state or reuse its earlier screenshots as
evidence for the corrected design. The earlier evidence below is historical.

Checkpoint checks after sheet removal: `cd ui; node --test` passed **378/378**,
including 14 building-control/start tests. `git diff --check` passed. The
`onStarting` and `onStartFailed` presentation callbacks are ready for the pending
panel hook and cannot delay first-prompt sending or cause duplicate session
creation. `talk.js`, `enterTalk()` and the City layout/hydration/pan internals
remain unchanged from `642fca9`. No corrected-flow browser or native acceptance
has been performed while the upstream dependency is missing.

## Superseded sheet implementation and historical evidence

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
