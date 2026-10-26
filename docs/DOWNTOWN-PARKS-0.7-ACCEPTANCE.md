# Downtown parks 0.7: local evidence

Prepared 2026-10-25 in `local/worktrees/07-parks`, branch
`codex/codaclauda-0.7-parks`, based on
`732b4a5ac2f88d13f961ac8c42b990195365faeb`.

## Implemented

Vacant Downtown lots use six original static toon models: a green square with
fountain, cafe with striped umbrellas and flowering planters, basketball court,
playground, community garden with greenhouse, and violet sculpture lawn. Their
lawns cover the former concrete pads. A stable coordinate hash selects each type
from disjoint checkerboard pools, preventing identical edge neighbours without
reshuffling when a lot fills or the city expands.

All parks share at most five mesh batches across the entire district, including
ink outlines, glass and lamps. Paths use the existing warm day/night lamp
material. Cafe string lights read the current renderer quality at draw time;
their emission becomes zero in low quality without rebuilding or moving anything.
The geometry has no animation or timers. All decoration leaves clicks to the
existing ground picker and new-project dialog.

Production changes are limited to `parks.js`, the old Downtown plaza branch in
`scenery.js`, and Downtown building bases/signs in `buildings.js`. Ghost lots use
lawn, an entry footpath and a small post sign reading "Clone to build". Real towers
use compact paving around their footprint and an entry walk, surrounded by lawn
and two to four planters. Occupied towers retain the existing shared bench. Tower
heights, origins, saved lot pins and clone routing remain unchanged. Suburbs,
Spark and contributor-island bases retain their established renderers.

Near a bridge approach the park narrows by 6% along x, preserving the bench
coordinates; building bases also fit their lawn and paving to existing clearance
checks. No camera, controls, river, boat, water, corridor logic, backend,
installation or release files change.

## Source tests and independent review

`cd ui; node --test`: **214 passed, 0 failed**. `git diff --check` passed.
Independent source review found and resolved trees on a crossing path, gaps in
basketball supports, insufficient cafe planting, and bridge-approach overlap.
The final review had no blocking source findings.

The building-base follow-up also checks ghost/link transitions, unchanged pins,
planter counts, and the maximum tower footprint at bridge approaches. Independent
review sampled 366 bases and 169,336 triangles with no river/bridge intrusion or
planting overlap with towers/shared benches. A coplanar ghost path was raised
slightly. Browser inspection exposed an existing arrival-to-growth transition
that left some bases at 60% scale; Downtown growth now finishes the base scale,
and reduced motion immediately settles its active arrival/growth. Regression
tests cover both ghosts and linked towers.

Tests cover stable selection/expansion, edge-neighbour uniqueness, occupied-lot
exclusion, actual geometry/river/bridge bounds, picking, resource disposal,
batch-count limits, and day/night/quality changes. A 114-by-114 top-down ray sample
over the full usable lot includes paving, furniture and the uncovered rim in the
denominator; planted soil and flower/crop surfaces count as planting.

| Type | Ordinary lot planted | Narrow bridge-side lot planted |
| --- | ---: | ---: |
| Green square | 74.88% | 70.57% |
| Cafe plaza | 64.19% | 60.57% |
| Sports court | 65.45% | 61.40% |
| Playground | 69.68% | 65.71% |
| Community garden | 75.19% | 71.55% |
| Sculpture lawn | 76.23% | 72.18% |

## Browser preview evidence

Headless Chrome uses the local UI and `ui/dev/mock.js` synthetic projects. This
is preview evidence, not installed/native or owner workflow acceptance.

- Actual canvas click on a park opens the Create tab of the new-project dialog.
- Actual ghost-sign click selects its repository, then opens the matching Clone
  dialog. Cancelling leaves the repository uncloned; pins and cells stay unchanged.
- Day/night views show multiple park types; the contact sheet shows all six.
- Reduced-motion snapshots have identical park vertices and transforms.
- Night path lamps and cafe string emission are warm; low quality turns off
  string emission while leaving path lamps lit.
- The eight-project, ring-three preview at 1600x1000, device scale 1, measured
  approximately 59.94 FPS at both qualities, with 16.8 ms p95 frame times on an
  RTX 4090 Laptop GPU. Short preview samples are not a sustained or other-device
  performance guarantee. No browser errors were observed.

Artifacts are local and untracked under `local/parks-07-evidence/` in the main
repository: `downtown-parks-day.png`, `downtown-parks-night.png`, `parks-sheet.png`,
`ghost-lot.png`, `tower-lot.png`, `park-new-project-dialog.png`, `parks-low-quality.png`, `browser.json`,
`ui-tests.txt`, and the reproducible `preview.cjs` harness.

Designer review is a separate handoff gate. The later combined branch must rerun
clearance and preview checks against the other teammate's river-loop work; that
integration is not part of this isolated-commit evidence. No publication or
installation is included.
