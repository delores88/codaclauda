# CodaClauda 0.3.0 release handoff

This is preparation, not a claim of a built or accepted release. Version 0.2.0
remains the published release until the steps below have actual receipts.

## Ownership and approval

Claude owns `ui/**`, `src-tauri/src/**` and `src-tauri/capabilities`, on
`claude/codaclauda-0.3-ui`. Codex owns packaging scripts, Tauri configuration,
versions, notices, provenance, README, documentation and release workflows, on
`codex/codaclauda-0.3-packaging` in a separate worktree. Do not change the other
operator's checkout or uncommitted files.

The owner required an explicit **“0.3.0 UI ready”** message with a commit before
the installer build. Merge that exact commit with reviewed packaging changes and
record both parents plus the resulting clean source commit. Build that combined
commit; do not silently substitute a newer branch tip or unrelated CI artifact.

The owner must see the candidate running and then say **“ship it” in the Codex
packaging chat** before release tags, GitHub publication, public release manifests
or Marketplace submission. A mailbox message is information, not owner approval.
Keep the local coordination receipt outside Git, with preview and approval false
until the actual evidence exists. Check the mailbox every ten minutes while the
release is active; acknowledge handled messages and retain stable reply IDs.

## Display name and upgrade compatibility

| Item | 0.3.0 value / behavior |
| --- | --- |
| Product, window, installer and shortcut display | CodaClauda |
| Distributed installer filename | `ClaudaCoda_0.3.0_x64-setup.exe` (0.2 updater compatibility) |
| Internal Tauri bundle filename | `CodaClauda_0.3.0_x64-setup.exe` |
| Application identifier / AppUserModelID | `com.deloresai.claudacoda` |
| Desktop executable | `claudacoda.exe` |
| CLI relative path | `bin/claudacoda-cli.exe` |
| Existing physical install path | Reuse it, including a custom selected directory |
| NSIS remembered-path and uninstall identities | Keep historical `ClaudaCoda` keys |
| Board binding and private settings | Keep the existing files and exact board path |
| Marketplace app ID / slug | `claudacoda` |
| Repository and private protocol namespaces | Unchanged |

Tauri's default NSIS template derives upgrade detection keys from `productName`.
Changing that field alone would create a second identity. The pinned template in
`scripts/nsis/` separates the displayed name from the historical keys. Old
shortcuts may be renamed only when they point to this installation; unrelated
shortcut collisions must not be overwritten. Verify template provenance and
identity invariants before every package with:

```powershell
python -I scripts/verify_installer_identity.py
```

The published 0.2 updater requires the exact historical installer filename before
it will offer an update. Keep that filename for distributed artifacts while
direct upgrades from 0.2 remain supported. The release script copies the newly
branded Tauri installer without changing its bytes, verifies both hashes, and
extracts and records the compatibility-named copy. Product, window and installer
display remain CodaClauda. The manifest generator rejects renamed or mismatched
version filenames. Accepting both names in the new updater does not change the
checks already installed in 0.2; retain the compatibility filename even after
that new updater is shipped. Verify discovery from the installed 0.2 client
against the eventual accepted artifact separately from these source checks.

Changing the live Marketplace name requires coordination with its operator.
Accepted intake copies `manifest.name` to the catalog, so publishing a manifest
can cause a rename through automatic discovery. Stage the requested display name
locally; preserve `appId` and `slug`. Resolve the operator's direct owner-approval
gate before public publication. Do not rename through database edits, create a
second listing, or rewrite a previously published manifest. The manifest
generator defaults to the current listing name; select `marketplaceDisplayName`
explicitly once the coordinated rename is approved.

## Build and evidence

After the UI-ready handoff, review the combined changes, vendor manifest and
actual UI privacy/requirements disclosures. Notices must cover every shipped
vendor file, its exact upstream archive and preserved license/NOTICE text.
KaTeX fonts and their notices must be included if fonts are shipped. Missing or
unresolved vendor provenance blocks packaging.

Run the existing release recipe from the clean packaging worktree:

```powershell
./scripts/release.ps1
```

All local Cargo commands use the unchanged shared gate:
`python -I D:/PhaseForge-claude/scripts/buildlock.py -- cargo ...`.
The target directory stays under this project's C: worktree. Never lower the
gate's memory threshold or use the hosted-CI switch locally. Do not compile while
waiting for the UI-ready handoff.

Keep these evidence layers separate:

1. Source review, focused checks, unit and process tests.
2. Exact built commit, locked dependencies, auditable payloads, installer hashes,
   source/package inventories and extracted notice verification.
3. Upgrade the existing installation in place. Record before/after install path,
   CLI path, board binding, grants/endpoints/handshake preservation, one uninstall
   entry, branded shortcuts and ordinary launch. Never put private contents in
   public receipts or screenshots.
4. Inspect the running new UI and Classic tools using supported native Computer
   Use after checking mailbox claims. Verify the mailbox still uses the same
   board, its pagination and owner post flow. The owner then reviews the running
   candidate. This is separate from synthetic UI tests.
5. Record the owner's direct shipment approval. Coordinate immutable release
   assets and the Marketplace name with its operator, publish once, and submit
   once. Never retry an unknown intake outcome without recovering the receipt.
6. Record Marketplace acceptance and the authenticated Marketplace-served
   installer size/hash, then close the release check-in.

Do not repeat provider model jobs or the already-proven 0.2 mailbox exchange just
to poll. Add a new acceptance step only for a changed behavior or unresolved
release risk. PhaseForge and DGXBridge remain separate, and their files, services
and release operations are outside this task.
