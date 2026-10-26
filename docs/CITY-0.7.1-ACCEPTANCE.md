# City 0.7.1 loading and interaction fixes

Base: `3e827cd5e7dec63cadbf360daeb18d9d66ea3683`.
Branch: `codex/codaclauda-0.7.1`. Scope: UI source and preview fixtures only.

## Reproduction and resulting behavior

A headless Chrome preview of the base, with `project_scan` never resolving,
still had zero cells and buildings after 4.5 seconds. The City had returned
before layout while initial manifest adoption awaited serial metadata work.

Known inventory now renders immediately. A provisional bank choice is not
saved until hydration settles or its single three-second deadline expires.
Saved banks remain authoritative, and later metadata does not swap the banks.
Provisional layout never writes automatic pin migrations; final placement
retains canonical and alias pin repairs.

Scans run through four physical request slots with ten-second caller timeouts.
Manifest and GitHub waits are bounded too. Re-entry shares pending work;
manifest revisions receive a follow-up adoption pass. Late scan and GitHub
answers cannot overwrite newer selections, relinked folders or explicit
removals. GitHub remote parsing matches exact owner/repository identities across
SSH, HTTPS, optional `.git`, case and dotted repository names; forks stay
distinct. Known local paths always render solid.

Pan has a visible toolbar button and P shortcut, plus the existing right-drag,
keyboard and touch controls. Invalid or missing island dimensions use the
minimum island bounds. Agent project aliases resolve to canonical buildings;
workers have separate positions within their lot and unassigned agents use the
HQ sidewalk perimeter.

## Verification performed

- `cd ui; node --test`: **364 passed, 0 failed**.
- `git diff --check`: passed.
- Independent reviews covered Store concurrency/identity/late responses,
  NPC placement and camera controls, and provisional layout/pin interaction.
- Deterministic tests cover slow, rejected and never-resolving work; absent or
  failing manifests; re-entry; the three-second deadline and one saved bank
  decision; bounded physical concurrency after timeout; remote forms/forks;
  alias placement; 32-agent spacing cases; pre-layout pan and Pan input guards.
- Headless Chrome browser pass: no page errors. Hanging scans and GitHub did
  not prevent layout or early right-drag pan. The saved bank choice occurred
  once, roughly 3.2 seconds after navigation in the final capture.
- Both banks opened the actual New Project dialog through pointer clicks:
  Downtown selected New GitHub repo; Suburbs selected Link an existing folder.
  Dialogs were cancelled; no repository or folder was created.
- A local-only sanitized inventory used 13 local folders and 6 repository-only
  entries from the app's project metadata. All 13 local buildings were solid
  before scans completed. Reload preserved the chosen bank and all 28 alias
  pin records. Synthetic activity exercised 16 distinct agent positions.
- The Pan button remained visible and operable at 390px viewport width.
  A desktop frame sample recorded 12.5ms median / 16.8ms p95; this is a browser
  preview sample, not an installed performance claim.

## Evidence and boundaries

Evidence lives under the repository's ignored `local/city-071-evidence/`:

- `baseline.json`, `before-hanging-scan.png`
- `browser.json`, `ui-tests.txt`, `preview.cjs`
- `after-hanging-scan-early.png`, `after-hanging-scan.png`
- `real-slow-overview.png`, `real-local-solid.png`
- `pan-before.png`, `pan-after.png`, `pan-mobile.png`
- `empty-downtown.png`, `empty-suburbs.png`
- `real-empty-downtown.png`, `real-empty-suburbs.png`
- `real-agents-spread.png`, `real-agents-hq.png`

The private fixture is untracked and contains only project names, paths and
sanitized repository identities/remotes. Credential and token files were not
opened. Browser activity, agents and machine status were synthetic; only the
project inventory came from local noncredential app metadata.

Native scans cannot be cancelled by this UI. A hung native call retains a
physical slot after its caller times out, preventing retry storms. If all four
native calls hang, further scans wait, while layout and interaction continue.

If identities are initially unknown, separate local and GitHub entries can
require an extra ring before they merge. Rendered capacity is retained for
that session to honor the no-shrink rule; correct pins and building positions
remain unchanged. Opening later with resolved metadata uses the normal
smallest fitting layout. This tradeoff has a focused regression test.

No installed/native acceptance, push, installation, publication or release
was performed. No Rust files changed; the Rust build gate was not invoked.
