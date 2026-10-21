# CodaClauda 0.6.2 hotfix scope

Base: published 0.6.1 source `445379f8ab48da004ad7ba5aaf604baf271fed59`.
The owner-reported live phone test exposed ntfy notification-clear events
causing an unsupported-event error and blocking later phone messages. The
source defect was independently confirmed; the private live topic was not
read or replayed by the release reviewer. Completed release bytes stay intact.

## Correction

Skip non-message events without routing their payloads. Persist validated
same-topic control-event IDs in order after prior messages succeed. Keep
open/keepalive cursorless, real-message validation strict, current settings
checked per event, existing receipt deduplication, and no automatic outbound
retry after an unknown result. Clear only the obsolete unsupported-event
diagnostic after progress; preserve unrelated errors.

Deterministic synthetic JSONL fixtures cover messages mixed with two clears,
a delete, a poll request and a future event; trailing cursor persistence;
restart/replay without duplicate messages; failure and owner-stop boundaries;
and rejection of invalid real messages or untrusted cursor identifiers.
These tests do not call ntfy or launch providers.

## Release and acceptance

Review the bounded diff and focused gated phone tests, freeze source, then run
the existing clean release recipe once. Every local Cargo call uses the
unchanged shared buildlock and this project's C: target, with the unchanged
10 GB threshold. Preserve identities, MIT notices, board binding and histories.
Use fresh 0.6.2 evidence and exact artifact hashes; never overwrite 0.6.1.

The owner is testing in the running app. Do not close or replace it until the
owner confirms it is safe to interrupt. Installed phone/board/agent delivery
must be recorded separately from fixtures, HTTP acceptance or source review.
Do not replay existing private messages merely to probe. Preserve unsigned
disclosures and actual vulnerability findings. GitHub publication, Marketplace
admission and native/served-download observations remain distinct.
