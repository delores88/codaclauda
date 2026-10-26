# City 0.7 UI acceptance

Prepared 2026-10-25 (local time) on `codex/codaclauda-0.7-city`. The river
refinement follows `53e721dc3f7fdfc43c9b24ddd30acb3f1c726939`; the branch is based
on `v0.6.2` (`ae5ddfadae2fa7d28655163a89b0e1fc1c204339`). This is UI source and
headless preview evidence. No Rust, installation, publication or external project
changes are included.

## Implemented behavior

- A gently winding river connects Downtown and Old Town. Its curve uses fixed
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
- Boat hulls cross the waterline, stay within the river and island, and fit under
  every bridge. Labels are mounted on the boats. Bridge decks, ramps, parapets,
  supports and docks form connected structures. Low quality has no river shadows.
- Downtown retains cool glass towers, planted plazas and pale ghost volumes for
  uncloned repositories. Ghosts are 83% of nominal height at 23% opacity, with
  supported ground signs and no ticker bands or rooftop CI effects. Old Town
  retains warm brick/timber, pitched roofs, gardens and lanterns.
- Real buildings retain roof tickers and the red CI beacon. CI creates no weather.
  Compact cranes have no suspended loads; growth effects follow building scale.
  Clone selection and new-project dialogs on both district sides remain available.
- Contributor islands keep their established layout; the river is hidden while
  visiting them. Spark remains available. Help and legend describe the river,
  bridges and boats, including `River boats = projects with recent commits`.

## Automated tests and independent review

`node --test --test-reporter=spec ui/tests/*.test.mjs`: **171 passed, 0 failed**.
`git diff --check` passed. Tests cover river extrema and full-footprint clearance,
220-project expansion, safe-pin preservation and migration, bridge surfaces and
ray picking, boat schedule/selection/containment/headroom, reduced motion, low
quality, scenery support and disposal, and routes across the river.

An independent source review checked the renderer, scenery and navigation. It
identified lateral entry through raised bridge walls, an empty-crossing-list
fallback, portal relocation behavior, bridge target identity, and expansion
alignment. These were corrected. Re-review found no blockers; 64,009 sampled
routes between dry/bridge/approach endpoints had no unsupported segments.

## Observed browser preview acceptance

Headless Chrome used `ui/dev/mock.js` on loopback, with synthetic projects. The
implementing Codex agent inspected the day/night, boat, bridge, expansion,
reduced-motion and growth/crane images. This does not establish installed/native
or real-owner workflow acceptance.

- Day/night and growth/crane previews completed without browser errors.
- An actual canvas click selected bridge 24 and walked the owner onto its deck.
  The final avatar height matched the bridge surface at y = 1.95.
- Sampled boats sat at water y = 0.18, with hull bounds spanning the waterline;
  independent geometry tests confirmed more than 0.5 units of bridge clearance.
  Boat and night-water captures showed no detached river furniture or loads.
- Reduced-motion snapshots had identical boat positions and water time. Low
  quality disabled renderer shadows and all river shadow flags, and used no
  water shader.
- Adding 24 synthetic repos expanded ring 3 to ring 5. Every existing cell stayed
  unchanged; all new cells were dry; free counts were 18 Downtown and 53 Old Town.
  River and island bounds both reached 93.5. Roads/decor/river stayed unscaled
  during growth, and the final capture settled the building rise animations.
- Actual empty-plot clicks opened Create in Downtown and Link in Old Town. An
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

## Local evidence

Current evidence lives in `local/city-river-evidence/` in the original checkout,
outside tracked files. The preceding visual evidence remains in
`local/city-07-evidence/`.

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

No release tag or installer was produced by this UI change. Source integration,
publication, installation and real-project acceptance remain separate steps.
