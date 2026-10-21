# CodaClauda 0.6.1 release scope

This is a source and acceptance plan. The amended builder handoff is
`cbde352f4685b37140bb1219e49c7f1009dffb03`, followed by independent review and
release corrections. The preliminary `5fac029` handoff is superseded. Completed
0.6.0 source `4ca6ef41b356e5fa308c0b4542d5ba4577e0fc19`, published artifacts and
historical receipts remain unchanged.

## Included behavior

- One saved ntfy HTTPS topic for incoming phone messages, agent replies and
  turn notifications. Messaging defaults on when a URL is saved; explicit Off
  remains effective. No separate inbound topic is required.
- Explicit agent-name/address routing and ordinary follow-ups to the last agent
  whose message ntfy confirmed for that topic. Unknown or ambiguous recipients
  do not fall back to the most recently active session.
- Ben's phone messages use the distinct `owner-phone` address and enter as
  ordinary owner messages under his direct authorization. Existing project
  access, grants and session controls remain unchanged. Topic knowledge and
  loop-filter tags do not authenticate a sender.
- Credential checks for incoming text and outgoing replies, durable cursors and
  delivery outcomes, and no raw message bodies in transport diagnostic logs.
  Normal board/provider conversation history remains separate.
- An explicit Send test button sends one fixed notice to the saved topic,
  independently of messaging and turn-notification switches. It starts no
  agent and does not automatically retry an ambiguous HTTP outcome.

See [Phone setup and delivery](PHONE.md) and [privacy](PRIVACY.md) for the exact
source contract. Builder-reported fixture results are not independent final
source verification, installed acceptance or proof of phone receipt.

## Release gates

Review the final routing, current-settings checks, credential handling, loop
filtering, restart deduplication and unknown outcomes. Freeze the reviewed
source, then run the existing clean release recipe once. Every local Cargo
invocation uses unchanged `python -I D:/PhaseForge-claude/scripts/buildlock.py -- cargo ...`,
this project's C: target and the unchanged 10 GB threshold. The recipe's required
package/fixture checks are separate from native phone acceptance.

Install only after active teammate work has finished and the app is safe to
close. Never close an active teammate merely to satisfy the installer. Preserve
physical installation identity, board binding, preferences, session histories
and phone routing/cursor receipts. Record actual before/after facts.

Keep native acceptance narrow: installed Phone settings, the intended phone
message/reply workflow and an explicit bounded test push. Distinguish local
save, ntfy acceptance, actual phone display, board admission and any provider
response. An HTTP success alone is not a phone round trip. Record limitations
or unknown outcomes without automatic replay. Do not repeat completed 0.6
suites, spend credits to probe limits or claim unobserved provider behavior.

## Distribution

Preserve CodaClauda, appId/slug `claudacoda`, publisher
`idFUpIv8h0zRX8OxpjsAWgQk`, bundle identifier `com.deloresai.claudacoda`, existing
paths and MIT distribution. Retain third-party notices and actual scan findings;
a passing inventory or scanner gate is not a claim of zero vulnerabilities.
Signing, native workflow acceptance, GitHub publication, Marketplace admission,
native listing and authenticated served bytes are separate evidence layers.
Use fresh 0.6.1 artifact/evidence pins and publish the reviewed version once;
never overwrite completed release bytes or replay an unknown mutation.
