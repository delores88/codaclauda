# CodaClauda 0.3.2 release plan

Version 0.3.1 is the accepted Marketplace baseline. A first 0.3.2 candidate from
`8aec460d38aad2265b9513acd18c80dcabc98980` was built and installed with the existing
board, profile, handshake and UI state preserved. Native checks reproduced Ben's
reported defect: the Spark side was illuminated while Machines said "Not
reachable." Publication is held for the corrected UI and installed verification.
No 0.3.2 release has been published or submitted. Private coordination receipts
record the latest exact source, build and installation outcomes.

## Authorization and reviewed handoff

Ben directly preapproved publication and Marketplace submission of 0.3.2 after
the required checks. No second literal “ship it” approval is required for this
release. The earlier approval wording in the historical 0.3.0 handoff does not
override this authorization. Mailbox messages remain information, not approval.

The initial UI-ready handoff was `8c77743579afdd8d8fd861327ca0014c5c143457`.
It restores **Grant & send** under Agent setup and fixes the native folder-picker
result handling and duplicate-submit risk found during review. Independent
review found no remaining release blocker in those fixes. This is source review;
build and installed acceptance remain separate below. The subsequent Spark fix
must use one confirmed, current connection state for the scene and Machines card.
Missing authentication, remote errors, failed checks and stale samples must not
show current remote work or reserved capacity. Historical job records must not
be presented as live activity while disconnected. Review the exact corrected UI
commit and repeat the installed offline scenario before publication.

The packaging correction at `56dca7d48667c30dba02381f85abceb4cbe78583` keeps
unestablished minimum OS and RAM requirements unspecified (`"0"` and `0` in the
Marketplace contract). Actual test-host OS and memory remain separate evidence;
they are not compatibility minimums. Architecture, measured installation size
and the WebView2 prerequisite retain their own evidence.

Independent review confirmed that the seven packaging changes only advance
first-party versions from 0.3.1 to 0.3.2. Dependency pins and install identities
are unchanged. This UI handoff's vendor tree, notices and provenance exactly
match released `8cde26090da111f8b8f98b73dfb3789eb54e0b6f`. Recheck the corrected
handoff for any additional vendor changes before relying on that result.

## Release sequence

1. Receive the corrected UI-ready commit. Claude owns the UI and native UI
   implementation; Codex owns packaging, versions and deployment. Independently
   review the repaired grant composer and the changed setup, updates, City and
   Talk workflows. Integrate the exact reviewed commit in the packaging branch,
   record both parents and the resulting clean source commit, and resolve any
   release blocker before building. Do not substitute a moving branch tip.
2. Build that clean combined source with `scripts/release.ps1`. Every local
   Cargo invocation must use the unchanged shared gate specified in `AGENTS.md`;
   keep the target directory under this project's C: worktree. Never lower the
   memory threshold or use the hosted-CI bypass locally. Retain the actual build
   receipt, focused checks, extracted executable hashes, auditable metadata,
   notice verification and source/package inventories.
3. Perform a guarded in-place install through the existing supported installer
   flow. Verify that active work does not make replacement unsafe. Record setup
   outcome and exact installed GUI/CLI hashes, existing install identity and
   path, board binding, settings, grants, endpoints and handshake preservation.
   Do not replace an unknown install outcome with an automatic retry.
4. Check the installed candidate with supported native Computer Use after
   coordinating shared UI ownership. Exercise the restored Grant & send flow
   and changed setup/update mappings, Talk navigation and City camera behavior.
   Use bounded checks that avoid unapproved provider launches or shared work.
   Record what actually ran and any limitations; unit tests and source review
   do not establish installed acceptance. A remaining blocker stops publication.
5. Recheck coordination with the Marketplace operator immediately before
   publication. Prepare exact immutable source, installer, notices, inventories,
   signing and tested-workflow evidence, with public receipts scrubbed of private
   paths, board contents and transcripts. Bind the manifest to actual source,
   tag, release and asset identities. Publish the new version once, use normal
   automatic intake, and recover its receipt before considering any further
   submission. Never duplicate an unknown outcome or overwrite published bytes.
6. Retain the exact Marketplace decision. Pending or unavailable progress is
   not rejection. Fix an actual rejection through a new immutable version when
   necessary. On acceptance, verify the ordinary MIT listing and authenticated
   Marketplace-served installer size and SHA-256 against the published artifact.
   Record completion and stop the release-specific watcher.

## Compatibility and evidence boundaries

Keep the CodaClauda display name, Marketplace app ID/slug `claudacoda`, existing
publisher and repository, MIT license and ordinary non-featured listing. Preserve
`com.deloresai.claudacoda`, `claudacoda.exe`, `bin/claudacoda-cli.exe`, historical
NSIS identities and the existing physical installation and board binding. The
distributed filename remains `ClaudaCoda_0.3.2_x64-setup.exe` for updater
compatibility; verify its bytes against the branded bundler output.

Source review, build/package integrity, installed workflow, publication,
Marketplace acceptance and served-download verification require separate actual
receipts. The first candidate's build and upgrade evidence is retained, while
final corrected native acceptance and release evidence remain pending. Reuse prior
evidence only with its original version and scope stated; do not present 0.3.1
acceptance or screenshots as a new 0.3.2 test. Preserve published 0.3.1 artifacts.
Keep private coordination details outside Git and do not rerun model or Spark
jobs merely to poll. Other projects, their services and their releases remain
outside this task.
