# CodaClauda 0.7.0 release scope

Base: completed 0.6.2 source `ae5ddfadae2fa7d28655163a89b0e1fc1c204339`.
The release integrates City `b0def4917b385b56c9eb0a1459cbc10eb2030abc`
and coordination fixes `f93fc1f64827c9eeb96e47bcfc5b32c652923803`, followed
by bounded release review corrections. Published 0.6.2 bytes remain unchanged.

## Changes

- City places GitHub-linked projects in glass Downtown towers and local-only
  projects in modern Suburbs homes, with parks and landscaped lots along a
  winding river. The larger district receives the larger bank; stable plots and
  alias repairs preserve placement as projects load and the island grows.
  Pale ghost buildings offer "Clone to build". Boats carry recent commit project
  names around the island and over the waterfall to the Spark side.
- City camera controls support fit, pan and zoom. Searchable Jump-to navigation
  puts working projects first and groups the remaining projects by district.
  The legend starts collapsed; rooftop beacons indicate failing CI.
- Mailbox reply waits accept 0–3600 seconds in the CLI, core and MCP. Other
  request waits retain their existing limit and MCP authorization is rechecked.
- Team replies include project names and Chat identifies the agents the app runs.
- Successful phone notices carry a short final-reply preview only after scanning
  the complete reply. Successful peer turns stay quiet; explicit owner-phone
  posts and error notices retain their existing route. Ambiguous sends never replay.
- Desktop wake status separates current endpoint evidence, command acceptance
  and exact board acknowledgment. Explicit remote routing remains mandatory;
  board acknowledgment does not establish provider identity or execution.

## Validation and release gates

The source branches report 149 City UI tests and 117 fixes UI tests respectively.
These are separate branch results, not an integrated test count. City changed
only the UI. On the fixes branch, the Rust workspace suite was blocked before
Cargo started by the unchanged 10 GiB memory gate; the Tauri suite was not started.
See [City evidence](CITY-0.7-ACCEPTANCE.md) and
[coordination evidence](ACCEPTANCE-0.7-FIXES.md) for the original limitations.

The final river City merge was independently reviewed against its saved UI
snapshot: 330 UI tests and seven browser checks passed. Its backend is unchanged
from the earlier integrated candidate, whose Rust workspace suite passed 127
tests with two ignored and whose desktop suite passed 189 tests. These results
are source and preview evidence, not native acceptance of the final package.

Freeze the combined source, validate the final UI, and build a fresh GUI and
installer while retaining the pinned evidence for unchanged components. Every
local Cargo call must use
`python -I D:/PhaseForge-claude/scripts/buildlock.py -- cargo ...`, with its
unchanged threshold and a target inside this C: project. Retain actual failures
and gate refusals. Do not launch duplicate builds or replay partial model work.

Preserve `com.deloresai.claudacoda`, Marketplace slug `claudacoda`, the installed
directory, board binding, owner settings and MIT/third-party notices. After the
authorized upgrade, leave the app running for the owner's phone use. Respect
active desktop claims and owner input before installation or native observation.

Record actual native City/Chat/Running observations separately from browser
previews and deterministic tests. Phone display, provider execution, silent peer
success, explicit owner-phone delivery and error notices each require their own
evidence; do not infer them from unit tests or manufacture private-message replays.
Missing observations remain disclosed. Installer integrity, GitHub publication,
Marketplace admission and authenticated served bytes are distinct evidence layers.
Keep unsigned disclosures and actual scanner findings; do not claim zero
vulnerabilities from source or packaging tests.
