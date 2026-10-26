# Building sessions in City talk mode

Date: 2026-10-26. Prepared for 0.7.2 in `local/worktrees/072-session`, branch
`codex/codaclauda-0.7.2-session`, rebased onto final City talk review commit
`b8be0db` (source checkpoint `b6ac1ac`, extending `132e434`). The caller flow
approved at `ce2db56` is unchanged. The new base supplies the wider shoulder
shot, head/bubble separation and final pending-session lifecycle.

## Behavior

Real local This PC buildings always show the New session block, including when
agents are present or the project is busy. Both provider buttons remain visible;
unavailable providers are disabled with an installed/sign-in reason. The block
includes an optional first prompt and current **Full access / Read only** pill,
matching the access levels actually enforced by the existing session path.
Enter starts the selected available provider. Tasks, folder, Rescan and Hide
remain secondary actions. Ghosts retain Clone; Spark and contributor islands do
not offer local session starts.

The building controls and the single-provider Chat dialog share
`startProjectSession`, which assembles the project folder/current access and
calls the existing `sessions.start` / native `session_start` path. The optional
prompt uses `sessions.send` on the admitted session. Discovery is an availability
hint; native launch still checks provider/authentication. No Rust command or
permission path was added. Chat's paired-session path is unchanged.

Starting from a building opens the existing NPC TalkPanel immediately with
`Starting <provider> in <project>...`. The upstream pending hook stages Ben at
that building and resolves only the returned session ID. The agent drops at the
reserved spot beside Ben and the existing live conversation appears on the
right. Agents here rows call `enterTalk(agent.id)` directly. There is no separate
chat sheet or alternate camera/staging implementation.

The TalkPanel header's **New session here** action opens the same project's
building controls, where the owner chooses Claude/Codex and an optional prompt.
It does not silently launch work. Both agent kinds use the same action. The
caller binds the documented header callback only for an eligible local project;
ghost, Spark, remote and removed projects omit it.

Each launch has an opaque context and its own pending handle. Closing, switching
conversation, leaving City or losing the renderer prevents late results from
reopening talk. Closing never stops the admitted session. A native refusal marks
only its pending talk as failed; switching buildings cannot display that failure
under a different project. A failed first send preserves the admitted session and
unsent draft in the building controls. Retry prompt sends to that same session;
Open session is an explicit reopen, distinct from an automatic error update.

## Validation

`cd ui; node --test` passes **463/463**, including **36** building-control and
caller-integration tests. These cover provider/project/access eligibility,
duplicate-start protection, exact pending identity, late admission/refusal,
same-session recovery, cross-project error isolation and header availability.
`git diff --check` passes.

The final hook waits for owner staging and the exact session NPC. Three older
caller fixtures initially lacked that staging model; they now verify admission
before staging, a registry row without its NPC, and final exact-NPC resolution.
Only tests and this acceptance record changed after rebasing the approved flow.

Independent source review checked owner-path reuse, project/access freshness,
provider availability, duplicate-start protection, pending identity, stale
callbacks and same-session recovery. The existing talk/NPC/world/layout/store
implementation remains inherited from the reviewed upstream candidate.

The headless browser harness passes **17 checks with zero page exceptions**. It
uses only the bundled mock backend, synthetic
projects/agents/transcripts, and intercepted provider commands. It checks local,
occupied/busy, ghost and Spark controls; unavailable-provider reasons; exact
start payload and pending identity; Ben and the matching agent at the reserved
building spot; header and Agents here navigation; delayed close/switch behavior;
start refusal; read access; failed-first-send recovery; ghost/remote header
omission; and mobile fit. Projected mesh bounds for the owner and target fit the
visible conversation area in the pending, desktop and mobile cases.

Evidence lives in the primary checkout's untracked
`local/072-session-evidence/`, including `browser-talk.json`,
`ui-tests-final-base-pass.log`, the preview harness and these review images:

- `building-panel-new-session.png`
- `talk-new-session-starting.png`
- `talk-new-session-on.png`
- `talk-new-session-mobile.png`

Earlier `chat-popup-*` screenshots and sheet-test results are superseded and are
not acceptance evidence for this implementation. Captures from before the final
talk-base rebase are retained under `pre-final-talk-base/`.

## Acceptance boundary

These are source tests and synthetic headless previews, not installed/native or
real-provider acceptance. No real provider session was launched. No Rust build,
installer, installation, push, release or integration into the release branch
was performed. Design review and an authorized installed workflow check remain
separate acceptance steps. The upstream desktop-history limitation documented
in `CITY-0.7.1-TALK-HANDOFF.md` is unchanged.
