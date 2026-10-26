# City agent locations and conversations

UI-only follow-up to `642fca9bc10bc05ad55b53e567f2e5e619ddbd99` on
`codex/codaclauda-0.7.1-talk`. The hydration, identity and Pan fixes remain in
the ancestry. No Rust, installation, publication or release changes are included.

## Behavior

- City agents use their observed current project, then their most recent known
  project, then HQ. Location hints come from session cwd, turns, assignments and
  retained board history. Owner preferences `cityAgentProjectsV1` and
  `cityAgentProjectsObservedV1` retain canonical project IDs and observation times
  by address. Message bodies are not copied into preferences. Hidden/deleted
  buildings fall back to HQ; aliases resolve to the same building. Idle and
  powered-down people remain at their project, with separated lot positions.
  Nested worktree/subfolder paths and merged local checkout aliases resolve to
  their canonical parent. Exact folder evidence across cwd/workspace/worktree
  outranks a folder-name guess. Dedicated endpoints retain their workspace hint;
  managed sessions can use `worktreePath` when cwd is unavailable.
- A managed session replaces its duplicate board-address figure. Its board
  address still resolves to that session. Contributor islands keep their own
  mapped agents and do not read/write home-city location memory.
- Figure clicks, name buttons, Jump-to, and Agents here rows enter the same talk
  mode. A genuine multi-agent cluster still offers a picker.
- The owner's custom avatar (or default You) drops beside the target. Conversation
  framing fits both figures in the visible area left of the panel or above the
  mobile sheet. It checks the final camera position and scenery sightlines;
  unavoidable foreground obstructions receive temporary cloned transparent
  materials, restored on leaving/reframing. Camera return preserves the saved
  pose. Latest messages appear as short bubbles; sends nod, replies gesture.
  The wider, elevated shoulder shot separates the two heads. Bubbles clear both
  head silhouettes, keep a horizontal gutter, and show up to three lines on
  narrow screens. They briefly wait if an avatar's drop occupies the speech area.
- Board agents carry an original toon clipboard and glance at it on send.
  Managed sessions carry no clipboard. Routing details appear in an info tooltip.
  The compact Legend adds `Clipboard: board agent`.

## Conversation routing

`TalkPanel` uses the existing owner-facing `sessions` client. Managed sends call
`sessions.send(sessionId, text)` and display that same session's live transcript;
they do not create a session per message. Board sends retain the existing stable
post-ID/retry path and display replies in the same thread. Switching/closing a
panel while a command is in flight cannot clear another draft or reopen it.

Desktop sessions expose metadata through the current backend, including their
provider session ID. The UI has no command to read their original transcript.
Talk shows the title when supplied (otherwise the known provider label), project
and last activity from session-file metadata. Its timestamp tooltip identifies
that source. The plain note is `This conversation lives in the Codex app. Send to
continue it here as a new session.` (Claude uses its own name).
Talk keeps the composer and offers **Continue in a new session**. The explicit confirmation uses the
existing `session_adopt` path with `mode: 'fork'`, then sends the draft into the
returned managed session. The provider copy carries context; old desktop lines
are not fabricated or imported into the new display log. Any transcript already
supplied on an agent record is rendered. Original desktop-history viewing remains
a backend limitation, not verified acceptance. A desktop transcript read command
is deferred to a later item; this follow-up remains UI-only.

## Hooks for the building-menu integration

```js
// Call before the existing owner start path. This hook itself starts nothing.
const talk = city.enterTalk(null, {
  pending: { provider: 'codex', projectId: project.id, label: 'Project helper' },
});
try {
  const session = await startUsingExistingOwnerControls();
  talk?.resolve(session.id); // also accepts a session record or sess:<id>
} catch (error) {
  talk?.fail(error);
}
```

The pending panel shows `Starting <provider> in <project>...` and stages the owner
at the canonical building. Resolution attaches only to the exact returned session
ID. The handle is returned synchronously and owns just this pending conversation.
`null` creates a separate internal pending identity; an explicit request ID also
works. Resolution waits for both the owner's staging and the matching City NPC,
including when the session record arrives before its figure. If the initial `id` already names the future session
(`sess:<id>`), its appearance resolves automatically. No provider/project guess
can select an unrelated concurrent start. `city.failTalk(id, error)` is an
alternate error setter. Repeated resolution/failure is harmless; the first
admitted session cannot be replaced and a later send failure cannot turn it into
a creation rejection. Leave, switching conversations, leaving City or destroying
the view makes the old handle inert. An admitted session keeps running after
dismissal without reopening talk. The hook does not start/stop providers, change
access, or send messages. Call `fail` only for creation rejection. A failed first
prompt belongs to the caller's same-session draft/retry controls.
`resolve()` returns whether talk has become live now: `false` while waiting for
staging does not mean that session admission failed.

New NPCs appear directly at their project with a short drop/puff. A pending talk
reserves a clear spot at that building and uses it when the exact session appears,
so the owner does not move across the lot during the transition.

`TalkPanel` accepts an optional
`onNewSessionHere(projectId, { projectId, provider, agentId })` callback. The first
argument preserves the published scalar contract; the second supplies the
provider hint and current agent identity. The same header action appears for
board and session agents, including busy agents. It requires a known canonical
project with a local folder. City's `canNewSessionHere(project, agent)` predicate
also omits the action on remote contributor islands and the Spark side.
For the already-created City panel, the caller can set:

```js
city.talkPanel.onNewSessionHere = projectId => openExistingStartControls(projectId);
city.talkPanel.refresh(); // if already open
// For a caller that expects one details object:
city.talkPanel.onNewSessionHere = (_, details) => openExistingStartControls(details);
```

Panel-level lifecycle methods are `open(agent, { pending })`,
`resolvePending(agent)`, `failPending(error)`, and `close()`. The City hook owns
the staging/registry transition; callers need not edit `talk.js`.

## Evidence and remaining acceptance

Initial `cd ui; node --test`: **408 passed, 0 failed** (2026-10-26).
Focused tests cover location
precedence/persistence/aliases/hidden projects, production Store home fallback,
shared lots, clipboard disposal, default avatar, drop/nod behavior, same-session
send/transcript, board retry, explicit copy, in-flight isolation, pending exact-ID
resolution/error/stale handles, camera return, and full-figure framing.

Local evidence is under `local/talk-071-evidence` in the main checkout. The browser
uses `ui/dev/mock.js`, the existing sanitized real project inventory, synthetic
agents/transcripts and intercepted mock owner commands. Baseline reproductions
show managed agents opening cards and preserve the distinction between custom
and default avatars. Final captures include `real-agents-idle-at-projects.png`,
`talk-enter.png`, `talk-bubbles.png`, `talk-exit.png`, `talk-mobile.png`,
`talk-board-dense.png`, `talk-default-avatar.png`, `talk-pending.png`,
`talk-pending-error.png`, `talk-desktop-copy.png` and `talk-after-spark.png`.

These checks are source and headless preview evidence. Real installed chat sends,
native rendering and provider-copy context acceptance remain unperformed.
Release stays on hold for review; no push, install or release is part of this work.

Independent review covered placement/pending transitions, conversation routing
and cleanup, and a separate browser reviewer. Four final browser harnesses
(`browser.json`, `routing.json`, `clicks.json`, `idle.json`) passed with zero
console/page errors. Actual pointer checks covered figures and name labels;
cluster checks used deliberately co-located synthetic agents. `review.md` and
`source-review.json` record the preview review and source identities. Local
screenshots and fixture data remain untracked.

The subsequent desktop metadata/text clarification was independently reviewed
and reran the complete UI suite: **408 passed, 0 failed**. The browser artifacts
above cover the main talk candidate; this text follow-up adds no native acceptance.

The later framing/placement review uses `local/talk-071-review-evidence` so the
original captures remain available for comparison. The four pale labels named
`acceptance-0.5.0`, `040-native-fixture` (twice), and `acceptance-0.4.1` are river
boat cargo project labels, verified against `river.boats[].projectLabels`; they
are not agent identities. This follow-up preserves those cargo labels. The idle
fixture explicitly exercises known nested/worktree/assignment/saved locations
and truly unknown agents. Unknowns keep separate HQ perimeter positions; their
colliding labels use the existing count chip and exact-member picker. Added
tests cover both label decluttering and the recovered workspace metadata paths.

Review milestone `cd ui; node --test`: **427 passed, 0 failed**. The pending hook,
header contract, placement paths, head separation, off-center scenery obstruction
and bubble layout have independent source review and focused regression coverage.

The refreshed `browser.json`, `routing.json`, `clicks.json`, `idle.json` and
`shot-qc.json` all pass with zero page/console errors. The required captures are
`talk-enter.png`, `talk-bubbles.png` and `real-agents-idle-at-projects.png` in that
review evidence folder, plus mobile bubbles and a real HQ cluster picker.
An interrupted local asset-loading run produced connection refusals; its report
and unstyled supplemental capture are retained under `interrupted/`. Sequential
reruns with an explicit stylesheet-readiness check passed. `source-review.json`
records the tested UI commit and screenshot hashes. These remain headless mock
checks; installed rendering and real provider sends/copy context are not claimed.

Bubble-anchor follow-up: collision layout retains the original owner/selected
NPC head coordinates. Each tail moves within its balloon and extends to that
same head after clearance shifts; it cannot inherit a nearby NPC's position.
If the intended figure is missing during pending startup or is outside a safe
anchor span, its bubble waits rather than pointing at a bystander. Production
method regressions cover reversed screen order, clamping, a decoy NPC, pending
absence and switching to another exact session. The pending/live/mobile browser
fixture checks both coordinates of each rendered tail against the intended head.
Evidence is in `local/talk-071-anchor-evidence`, separate from earlier captures.
This follow-up passes **432 UI tests** and the pending/live/mobile anchor preview
with zero browser errors. Rendered tail X and Y are checked against the intended
head, including the real CSS pseudo-element. This remains synthetic preview
evidence rather than native/provider acceptance.
