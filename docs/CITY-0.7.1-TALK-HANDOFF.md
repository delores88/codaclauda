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
Talk therefore states that the history is in the desktop app, keeps the composer,
and offers **Continue in a new session**. The explicit confirmation uses the
existing `session_adopt` path with `mode: 'fork'`, then sends the draft into the
returned managed session. The provider copy carries context; old desktop lines
are not fabricated or imported into the new display log. Any transcript already
supplied on an agent record is rendered. Original desktop-history viewing remains
a backend limitation, not verified acceptance.

## Hooks for the building-menu integration

```js
// Call before the existing owner start path. This hook itself starts nothing.
const talk = city.enterTalk(requestId, {
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
ID. If it has not appeared yet, the ID is retained and a later registry update
completes the transition. If the initial `id` already names the future session
(`sess:<id>`), its appearance resolves automatically. No provider/project guess
can select an unrelated concurrent start. `city.failTalk(id, error)` is an
alternate error setter. Leave or switching conversations makes the old handle
inert. The hook does not start providers, change access, or send board mail.

New NPCs appear directly at their project with a short drop/puff. A pending talk
reserves a clear spot at that building and uses it when the exact session appears,
so the owner does not move across the lot during the transition.

`TalkPanel` accepts an optional `onNewSessionHere(projectId)` constructor callback.
Its header action is shown only when that callback and a known project exist;
the argument is the canonical project ID for board and session agents alike.
For the already-created City panel, the caller can set:

```js
city.talkPanel.onNewSessionHere = projectId => openExistingStartControls(projectId);
city.talkPanel.refresh(); // if already open
```

Panel-level lifecycle methods are `open(agent, { pending })`,
`resolvePending(agent)`, `failPending(error)`, and `close()`. The City hook owns
the staging/registry transition; callers need not edit `talk.js`.

## Evidence and remaining acceptance

Final `cd ui; node --test`: **408 passed, 0 failed** (2026-10-26).
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
