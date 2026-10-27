# CodaClauda 0.7.2 City launcher correction

This hotfix follows the completed 0.7.1 release. It preserves that release's
artifacts and the existing City conversation interface.

- Local building menus offer Claude and Codex through the managed session
  engine. Legacy board discovery no longer incorrectly disables Claude.
- Selecting a provider starts one blank session and opens the existing City
  TalkPanel. Write the first message in that panel, beside the owner's avatar
  and the new agent. The building menu has no prompt or send control.
- New session here returns to the same provider choices. Existing access,
  local-project restrictions, exact session routing and Open session recovery
  remain in place. TalkPanel owns message sending and retry.

Source tests and independent review are recorded separately from installed
acceptance. Before delivery, install the exact candidate and check both provider
choices on a real local project, the existing TalkPanel composer and agent
placement, and the preserved City interactions. A provider response is separate
evidence from blank-session admission. Preserve the owner's settings and board;
do not manufacture project activity or retry ambiguous turns.

Use the unchanged shared Cargo gate and a target inside this C: project. Retain
MIT licensing, third-party notices, unsigned-package disclosure and any actual
scanner findings. This UI correction does not change Spark transport or prove
new Spark workload execution.
