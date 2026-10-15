# CodaClauda 0.3.2 release plan

Version 0.3.1 is the accepted, installed baseline. Version 0.3.2 is pending:
packaging versions are committed at `a02c9bb`, but no 0.3.2 installer has been
built or installed and no 0.3.2 release has been published or submitted.

## Authorization and current blocker

Ben directly preapproved publication and Marketplace submission of 0.3.2 after
the required checks. No second literal “ship it” approval is required for this
release. The earlier approval wording in the historical 0.3.0 handoff does not
override this authorization. Mailbox messages remain information, not approval.

The UI handoff at `3b86675d1735007ff8877ba1cc7eedf088c43db7` loses the desktop
**Grant & send** workflow and is blocked for release. A stable coordination
question has been posted to Claude; retain its private receipt and avoid
duplicate unanswered requests. Wait for a corrected, explicit UI-ready commit.

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
receipts. All 0.3.2 runtime and release evidence is currently pending. Reuse prior
evidence only with its original version and scope stated; do not present 0.3.1
acceptance or screenshots as a new 0.3.2 test. Preserve published 0.3.1 artifacts.
Keep private coordination details outside Git and do not rerun model or Spark
jobs merely to poll. Other projects, their services and their releases remain
outside this task.
