# CodaClauda 0.7.2 City conversations and projects

This candidate extends the completed 0.7.1 release. Source behavior below is
separate from installed acceptance and publication.

## City conversations

- Local building menus offer Claude and Codex through the managed session
  engine. Each choice opens one blank session in the existing City TalkPanel;
  the building menu has no message composer. Existing access and session
  routing still apply.
- Windows discovery recognizes current Claude Code bundles under
  `LocalAppData/Claude-Data/<Anthropic package family>/claude-code`, as well as
  older supported locations. Finding an executable does not establish sign-in,
  available usage or a successful reply.
- Conversation framing places the owner and agent beside one another, with a
  compact header and readable speech bubbles. Completed board replies can
  appear above the corresponding agent.
- City buildings have additional shapes, colors and roof details. Uncloned
  repositories use opaque **Clone to build** plots. Riverfront buildings follow
  their lots. The original panning, empty-plot Create and local-building
  opacity checks remain part of installed acceptance.

## GitHub accounts and local projects

- Projects can show multiple GitHub accounts in one City or place owned
  accounts on separate islands. Contributor islands remain distinct. Account
  islands have labels and airfields for agent travel.
- Clone selected repositories or a whole account into a chosen local parent
  folder. Progress remains available after closing the dialog. A clone stops
  when its destination already exists and never overwrites or automatically
  links that folder. The owner can inspect it and use Projects to link it.
- Building names can be edited locally. **Remove from City** changes visibility,
  leaving the local folder and GitHub repository intact. Projects provides
  recovery and management controls.
- Account selection must remain explicit throughout lookup and cloning.
  Failure to obtain the selected account's authorization is an error, not a
  reason to use a different account.

## Phone approvals

The owner can answer approval requests through the saved ntfy topic using
one-time codes and Approve/Deny actions. Codes expire, are held only in memory,
and lock after repeated wrong answers. The desktop provides an unlock control.
The `owner-phone` sender is reserved for the phone bridge. Anyone with access
to the topic can read its codes; topic secrecy is not sender authentication.
See [phone behavior and privacy](PHONE.md).

Phone answers must respect the messaging/approval switches, current session
bindings, wake controls and duplicate-delivery protections. A saved board reply
does not establish that a provider accepted or completed a turn.

## Release acceptance

Freeze the reviewed source, run the offline source gates, build and inspect its
installer, then install that exact candidate locally. Actual installed City
interactions and a bounded reply from each provider are required before source
push, GitHub publication and Marketplace submission. New account/clone/travel
and phone behaviors need their own evidence; tests and browser previews do not
substitute for those workflows. Authentication and physical-phone steps remain
owner-operated when required.

Use the unchanged shared Cargo gate and a target inside this C: project. Retain
MIT licensing, third-party notices, unsigned-package disclosure and actual
scanner findings. These changes do not establish new Spark or GPU workload
acceptance. Published 0.7.1 artifacts remain unchanged.
