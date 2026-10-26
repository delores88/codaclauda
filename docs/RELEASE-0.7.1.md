# CodaClauda 0.7.1 release scope

Base: completed 0.7.0 source `3e827cd5e7dec63cadbf360daeb18d9d66ea3683`.
The combined City handoff is `549674aa1d96d0b863ce0717e7d21166ad2cb109`,
followed by a bounded conversation-retry correction and release metadata.
Completed 0.7.0 artifacts remain unchanged.

## Changes

- City renders known projects while slow metadata requests finish. Linked local
  projects remain solid, and GitHub repositories match by their full identity.
- Agents retain their last known project, including nested folders and worktrees,
  and use separated positions. Pan has a visible button and a keyboard shortcut.
- Clicking an agent opens a conversation with the owner's avatar beside it and
  the chat at the right. Speech bubbles stay attached to the intended figures.
  Foreground scenery can become temporarily transparent during a conversation;
  leaving the conversation restores its original materials.
- Owned-session messages continue in the same session. Board conversations use
  the existing mailbox. Desktop conversations require explicit confirmation to
  continue as a labelled copy; the original desktop transcript is not imported.
- Local buildings offer **New session** with Claude or Codex and an optional
  first prompt. **New session here** opens those controls. Current project access
  and native admission checks apply; ghost, Spark and contributor buildings do
  not offer local starts.
- A failed first send after leaving or switching a desktop-copy conversation
  retains the admitted session for explicit retry. The send stays locked while
  unresolved, and recovery cannot reuse a copy belonging to a changed source.

## Validation and release gates

The corrected UI suite passed **475 tests**. Three new regression cases failed
on the handoff source and passed after the correction. Four additional cases
check changed conversation, folder, provider and agent identities. Independent
source reviews cover the four City fixes, conversation/session controls, and the
bounded retry correction. These are source results, not installed acceptance.

Build fresh 0.7.1 GUI and CLI payloads using the unchanged shared gate:
`python -I D:/PhaseForge-claude/scripts/buildlock.py -- cargo ...`.
Keep the target inside this C: project and retain the 10 GiB threshold. Bind any
reused test evidence to unchanged tested bytes; retain failures and corrected
outcomes separately. Preserve MIT licensing and third-party notices.

Install the exact reviewed candidate locally, then verify all six behaviors in
the real installed app:

1. Agents occupy separated positions at their projects.
2. Panning moves the view.
3. An empty Downtown plot opens Create; stop before submitting a project.
4. Known local project buildings are opaque in normal City view.
5. Clicking an agent stages the owner beside it, opens the conversation at the
   right, and a short reply returns to that same managed conversation.
6. A local building's New session starts one agent there and opens its conversation.

One new managed session and one short reply turn can cover the two added cases.
No private desktop-original continuation, unrelated phone, Spark/GPU workload,
or other-product acceptance is part of this gate. Unknown or partial turns must
not be blindly repeated. Preserve the owner's settings, board and ordinary
DGXBridge binding.

Only after all six actual results pass and are independently reviewed may the
accepted source be pushed, the GitHub release published and the Marketplace
submission made. Installation, provider response, publication, Marketplace
admission and authenticated served downloads remain separate evidence layers.
Retain unsigned-package disclosures and actual scanner findings; source tests
do not establish zero vulnerabilities.
