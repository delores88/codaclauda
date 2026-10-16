# CodaClauda 0.3.3 release plan

The accepted baseline is 0.3.2 at source
`2edbcb50201a359e1b5dfac3325deaa6213c0d26`. Its native Marketplace listing and
authenticated served-installer verification are complete. Preserve those
immutable artifacts and receipts.

The exact UI handoff is `885b6a2315f59c25eeed259b98d2c6e101da9718`.
It adds contributor islands, a route map and portal, optional City weather,
small Talk/camera/board fixes, and an About non-affiliation statement. Project
access levels, building tickers and session control remain deferred to 0.4.
The handoff reports 40 UI tests and 49 Rust tests passing. Those reported results
are distinct from packaging checks and actual installed acceptance.

Ben directly authorized this chat to carry out Claude's board requests on a
standing basis, including the release workflow. The direct instruction supplies
authority; mailbox labels and messages do not independently prove owner approval.
Later direct owner limits and system safeguards still apply.

## Required release evidence

1. Independently review the exact handoff, preserve the 0.3.2 packaging and
   compatibility corrections, and include README non-affiliation plus weather
   privacy disclosures in the documentation and Marketplace manifest. Retain
   the IANA time-zone table provenance and external data attribution.
2. Build a clean combined source with `scripts/release.ps1`. Use the unchanged
   shared Cargo gate, its unchanged 10 GB threshold and the project-local C:
   target. Keep actual tests, extracted payload hashes, dependency inventories
   and notices separate from workflow acceptance.
3. Perform one guarded in-place installation, retaining physical path, GUI/CLI
   identities, board binding, settings and recorded work. Verify actual setup
   outcome and installed hashes before native checks.
4. Check the installed contributor route map and island navigation, returning
   to the home City, Talk/board changes, Weather settings, local weather choices,
   and weather-off behavior. Exercise live weather/search only through their
   explicit controls and record network outcomes separately. Do not infer
   provider presence, repository access or a model job from scene activity.
5. Coordinate Marketplace intake, publish the new immutable version once with
   exact source/artifact/manifest pins and reviewed public evidence, retain the
   actual terminal decision, then verify the ordinary MIT listing and exact
   authenticated served-installer bytes without reinstalling.

## Stable identity and boundaries

Keep display name CodaClauda, app ID/slug `claudacoda`, the existing publisher,
MIT ordinary non-featured status, `com.deloresai.claudacoda`, `claudacoda.exe`,
`bin/claudacoda-cli.exe`, existing NSIS identity and install path. The distributed
installer name is `ClaudaCoda_0.3.3_x64-setup.exe` for updater compatibility.
Unknown minimum OS/RAM remain unspecified; test-host details are not minimums.
No other project's source, services, sessions or caches are changed. Private
state and receipts stay outside public source. Publication and installed native
acceptance remain pending until their own receipts establish completion.
