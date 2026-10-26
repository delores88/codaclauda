# City 0.7 UI acceptance

Prepared 2026-10-25 (local time) on `codex/codaclauda-0.7-city`. The river
refinement follows `53e721dc3f7fdfc43c9b24ddd30acb3f1c726939`. The six-boat follow-up
builds on river commit `9ff9a0068a6e9319df14d844745aca10601c0218`; the branch is based
on `v0.6.2` (`ae5ddfadae2fa7d28655163a89b0e1fc1c204339`). This is UI source and
headless preview evidence. The Suburbs refinement below builds on
`663623ad21fd66c1a500d08ebc95638d65753ffb`. No Rust, installation, publication or
external project changes are included.

## Implemented behavior

- A gently winding river connects Downtown and Suburbs. Its curve uses fixed
  world coordinates, so expansion extends the water without shifting existing
  banks, bridges or safe pins. Water has subtle surface animation, calmer at
  night; low quality uses a simple material. Banks have grass and stones.
- Each crossing street has a supported road bridge with continuous approaches.
  Clicking a bridge walks the avatar there. Paths and street controls use dry
  banks and bridge approaches, including the deck's actual height. Water and
  reserved bank clearings cannot be selected as project plots.
- Plot assignment checks the entire lot and sidewalk footprint against the river
  envelope. Newly unsafe or district-mismatched pins migrate once; valid pins and
  subsequent placements remain stable through expansion and reopening. Each
  district keeps at least three unreserved empty plots. Hidden reservations and
  project aliases remain supported.
- Expansion keeps roads, banks and bridges fixed while animating the island's
  depth below ground and emitting dust. New buildings retain their rise animation.
- Small independent boats pass every randomized 90-180 seconds. Travel speed grows
  on very large islands so a pass clears before the next departure. Up to six carry
  recent project labels: commits within 24 hours, or weekly counts when a commit
  date is unavailable. With no activity, unlabelled boats pass. Reduced motion
  moors up to two boats at the dock and freezes the water. No sound is used.
- Six original low-poly models distinguish sailboats, rowboats, tugboats, cargo
  barges, paddle steamers and canoes. A shuffled bag visits every type before
  refilling and prevents consecutive repeats across fleets. All types can carry
  recent project names; barges carry up to three distinct names. Quality and label
  refreshes preserve the chosen hulls and moored positions without consuming the
  next type choices. Low quality reduces model detail and disables shadows.
- Boat hulls cross the waterline, stay within the river and island, and fit under
  every bridge. Labels are mounted on the boats. Bridge decks, ramps, parapets,
  supports and docks form connected structures. Low quality has no river shadows.
- Downtown retains cool glass towers, planted plazas and pale ghost volumes for
  uncloned repositories. Ghosts are 83% of nominal height at 23% opacity, with
  supported ground signs and no ticker bands or rooftop CI effects. Suburbs use
  low modern homes, lawns, driveways and slim street lights; their refinement is
  recorded separately below.
- Real buildings retain roof tickers and the red CI beacon. CI creates no weather.
  Compact cranes have no suspended loads; growth effects follow building scale.
  Clone selection and new-project dialogs on both district sides remain available.
- Contributor islands keep their established layout; the river is hidden while
  visiting them. Spark remains available. Help and legend describe the river,
  bridges and boats, including `River boats = projects with recent commits`.

## Automated tests and independent review

At the six-boat checkpoint,
`node --test --test-reporter=spec ui/tests/*.test.mjs`: **184 passed, 0 failed**.
`git diff --check` passed. Tests cover river extrema and full-footprint clearance,
220-project expansion, safe-pin preservation and migration, bridge surfaces and
ray picking, boat schedule/selection/containment/headroom, reduced motion, low
quality, scenery support and disposal, and routes across the river.

An independent source review checked the renderer, scenery and navigation. It
identified lateral entry through raised bridge walls, an empty-crossing-list
fallback, portal relocation behavior, bridge target identity, and expansion
alignment. These were corrected. Re-review found no blockers; 64,009 sampled
routes between dry/bridge/approach endpoints had no unsupported segments.

The boat follow-up received a separate independent source review. It checked
all twelve model/quality combinations at 101 positions each (1,212 clearance
samples), label backing-board contact with the hull, dock gaps, resource disposal,
recent-commit filtering and stability through ten quality/label refresh cycles.
No blocking findings remained. The visual pass also moved plaques clear of oars
and paddle wheels before the final captures; 216 sightline rays verify these
labels remain unobstructed from either side at both quality levels.

## Observed browser preview acceptance

Headless Chrome used `ui/dev/mock.js` on loopback, with synthetic projects. The
implementing Codex agent inspected the day/night, boat, bridge, expansion,
reduced-motion and growth/crane images. This does not establish installed/native
or real-owner workflow acceptance.

- Day/night and growth/crane previews completed without browser errors.
- An actual canvas click selected bridge 24 and walked the owner onto its deck.
  The final avatar height matched the bridge surface at y = 1.95.
- Sampled boats sat at water y = 0.18, with hull bounds spanning the waterline;
  all six current model types satisfy at least 0.18 units of bridge clearance.
  The tallest model, the sailboat, measured 0.24 units below the bridge underside.
  Boat and night-water captures showed no detached river furniture or loads.
- Reduced-motion snapshots had identical boat positions and water time. Low
  quality disabled renderer shadows and all river shadow flags, and used no
  water shader.
- Adding 24 synthetic repos expanded ring 3 to ring 5. Every existing cell stayed
  unchanged; all new cells were dry; free counts were 18 Downtown and 53 Suburbs.
  River and island bounds both reached 93.5. Roads/decor/river stayed unscaled
  during growth, and the final capture settled the building rise animations.
- Actual empty-plot clicks opened Create in Downtown and Link in Suburbs. An
  uncloned repo's ground sign opened the existing Clone dialog with the correct
  repo selected. No repository was cloned. Water returned no project plot.
- Spark flipped PC to Spark to PC. Contributor round trips starting on a bridge
  and in Downtown returned the owner to HQ and preserved exact home pins/cells.
  The river was hidden while away. All completed preview runs had no browser errors.

At 1600x1000, device scale 1, eight matching synthetic projects and a fixed camera,
sequential 3.5-second rAF samples on an RTX 4090 Laptop GPU (ANGLE D3D11) measured:

| Preview | High quality | Low quality | p95 frame time |
| --- | ---: | ---: | ---: |
| Baseline 53e721d | 59.942 FPS | 59.942 FPS | 16.8 ms |
| River refinement | 59.942 FPS | 59.942 FPS | 16.8 ms |

These samples support the 60 Hz preview target on this machine. They are not a
sustained performance guarantee for larger cities, other hardware or an installed
WebView. The river sample used 951 high-quality / 825 low-quality draw calls,
versus 948 / 822 in the matching baseline scene.

The six-boat follow-up repeated the day/night, expansion, bridge click,
reduced-motion and low-quality checks, and captured each model at both quality
levels. Every hull crossed the waterline; all labels had physical mounts. The
sailboat was also captured under a bridge. These runs had no browser errors.

A separate sequential comparison against river commit `9ff9a00` kept all six
boats visible throughout each 3.5-second sample, with the same eight-project
fixture, viewport, camera and GPU described above:

| Preview with six visible boats | High quality | Low quality | p95 frame time |
| --- | ---: | ---: | ---: |
| River baseline 9ff9a00 | 59.93 FPS | 59.94 FPS | 16.8 ms |
| Six-model boat variety | 59.94 FPS | 59.94 FPS | 16.8 ms |

The current scene used 1,033 / 901 draw calls versus baseline 999 / 873
(high / low). This is a short headless preview sample, not sustained or installed
performance acceptance.

## Suburbs refinement and acceptance

Local-only projects now use four lot-hash-selected modern home shapes:
cantilever, L-shaped ranch, split-level and townhouse pair. Light stucco volumes,
dark-framed windows, charcoal roofs and a wood entry accent replace the earlier
architecture. Every home has a garage, driveway, lawn, one or two trees and a low
fence. Homes stay at one or two storeys; larger project metrics widen their wings
and garages without adding height. The active-agent state adds a contractor van
with an amber beacon, a wall ladder and solar-panel glints. Wall lights and slim
modern street lamps glow warmly at night. Empty grass parks, Downtown plazas and
towers retain their existing behavior. Help, legend and panel pills say Suburbs.

`node --test` from `ui`: **203 passed, 0 failed**. `git diff --check` passed.
New coverage includes all four shapes across three size tiers, fixed height and
outward growth, pin/alias preservation through district renaming and expansion,
rendered lawn/path/driveway heights, offset-wing and contractor collision,
courtyard access, physical attachments, roof markers, resource disposal and
reduced motion enabled during growth. Existing Downtown, contributor and Spark
architecture tests remain green.

Independent source and geometry review checked twelve variant/tier combinations.
It found and prompted fixes for entry-tree clearance, yard/sidewalk alignment,
small attachment gaps, raised-yard walking heights and offset-wing collision.
The final home geometry review passed. Independent collision and surface-height
integration review also passed, with 16 focused tests rerun and no blocking
findings.

Observed headless Chrome acceptance, with synthetic mock data:

- Inspected all four home variants, day/night close-ups, overview, growth,
  reduced-motion and Low-quality captures. No detached home elements were visible
  in the inspected frames. Growth retained its roof height and exact lot/pins.
- An actual canvas click opened a home's Suburbs panel. Empty plots opened Create
  Downtown and Link in Suburbs. A ghost's ground sign opened Clone with the correct
  repo selected; the dialog was cancelled. Water remained unselectable as a plot.
- Owner placement on the entry path matched its rendered top at y = 0.2865.
  Both camera zoom and street walking recognized the rear wall of the offset wing.
- Reduced motion froze the contractor beacon and solar glints, and settled an
  in-progress home expansion. Low quality disabled renderer shadows.
- Spark flipped to its underside and back. Contributor trips from the bridge and
  Downtown returned to HQ, preserving exact home pins and cells. No browser errors
  occurred in the completed runs.

Sequential 3.5-second rAF samples used the same ten-project fixture (four homes,
one active contractor), camera, 1600x1000 viewport, device scale 1 and RTX 4090
Laptop GPU with ANGLE D3D11:

| Preview | High quality | Low quality | p95 frame time | Draw calls (High / Low) |
| --- | ---: | ---: | ---: | ---: |
| Baseline 663623a | 59.94 FPS | 59.94 FPS | 16.8 ms | 1,090 / 951 |
| Modern Suburbs | 59.94 FPS | 59.94 FPS | 16.8 ms | 1,102 / 963 |

These short samples establish headless preview behavior on this machine, not
installed/native acceptance or sustained performance on larger cities.

The separate proposed diagonal S-bend river, asymmetric quay, waterfalls and
continuous boat circuit through the Spark side are **not implemented by this
refinement**. Bridge/mast clearance and preserving dry pins across a new diagonal
district boundary still need design resolution. The current river behavior above
describes the existing checkpoint, not acceptance of that later design.

## Local evidence

River evidence lives in `local/city-river-evidence/` in the original checkout,
outside tracked files. Earlier City evidence remains in `local/city-07-evidence/`.

- `after-day.png`, `after-night.png`, `after-grow.png`, `after-crane.png`
- `after-boats.png`, `after-boats-night.png`, `after-bridge-click.png`,
  `after-expansion.png`, `after-reduced-motion.png`, `after-low-quality.png`
- `after-clone-dialog.png`, `workflow-reduced-motion.png`,
  `workflow-low-quality.png`, `workflow-spark-flip.png`, and contributor/home
  round-trip captures listed by `workflow.json`
- Receipts: `tests.txt`, `after-browser.json`, `river-check.json`,
  `interaction-check.json`, `workflow.json`
- Reproduction scripts: `preview.cjs`, `river-check.cjs`, `interaction-check.cjs`,
  `workflow-check.cjs`

The latest boat-variety evidence is in `local/city-boat-variety-evidence/`:

- `high-{sailboat,rowboat,tugboat,barge,paddle-steamer,canoe}.png` and matching
  `low-*.png` close-ups, `six-boats-day.png`, `six-boats-night.png`,
  `sailboat-under-bridge.png`, `moored-boats-day.png`, `moored-boats-low.png`,
  `baseline-six-boats.png`, `after-six-boats-default.png`
- `after-boats.png`, `after-boats-night.png`, `after-bridge-click.png`,
  `after-expansion.png`, `after-reduced-motion.png`, `after-low-quality.png`
- Receipts and reproduction: `tests.txt`, `river-check.json`, `variety-check.json`,
  `river-check.cjs`, `variety-check.cjs`

Suburbs evidence is in `local/city-suburbs-evidence/` in the original checkout:

- `before-{overview,day,night}.png`, `after-{overview,day,night}.png`
- `after-{cantilever,l-ranch,split-level,townhouse-pair}.png`,
  `after-reduced-motion.png`, `after-low-quality.png`, `home-growth.png`,
  `home-panel.png`, `after-clone-dialog.png` and the `workflow-*.png` captures
- Receipts: `tests.txt`, `before-preview.json`, `after-preview.json`,
  `home-workflow.json`, `interaction-check.json`, `workflow.json`
- Reproduction: `preview.cjs`, `home-workflow.cjs`, `interaction-check.cjs`,
  `workflow-check.cjs`
- Review copies: `local/city-07-evidence/suburbs-{overview,day,night}.png`

No release tag or installer was produced by this UI change. Source integration,
publication, installation and real-project acceptance remain separate steps.
