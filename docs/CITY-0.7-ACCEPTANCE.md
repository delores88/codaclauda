# City 0.7 UI acceptance

Prepared 2026-10-25 on `codex/codaclauda-0.7-city`, based on
`v0.6.2` (`ae5ddfadae2fa7d28655163a89b0e1fc1c204339`). UI changes only;
no Rust, installation, Marketplace, release or external project changes.

## Implemented behavior

- GitHub identities occupy Downtown, with translucent outlines until a local
  folder is linked. Local-only folders occupy Old Town. Contributor islands
  retain their existing layout and the Spark underside remains available.
- The railway follows the street at z = -8. Downtown has cool glass towers and
  paved plots; Old Town has brick/timber, pitched roofs, gardens and lanterns.
- District placement preserves valid pins and standing buildings, corrects a
  wrong-side pin once, persists aliases, and grows until both districts have
  at least three unreserved empty plots. Tracks grow with the island.
- Trains depart at randomized 90–180 second intervals, with at most six named
  cars. Commit dates within 24 hours take precedence; missing/invalid dates
  fall back to `commits_7d`. No activity produces empty cars. Crossings warn
  before arrival. Reduced motion parks the train; low quality has no shadows.
- Failed CI uses a roof-attached red beacon and `CI failing` ticker text.
  CI creates no weather. Compact cranes have no suspended loads. Mesh and
  instanced outlines inflate about their own geometry centers; construction
  sparks follow the tower's animated scale.
- Clicking an outline opens its project panel and the existing clone dialog
  with that repository selected. Empty plots open the existing project dialog
  on both sides. Legend, help and synthetic preview data cover all three states.

## Automated tests and independent review

`node --test --test-reporter=spec ui/tests/*.test.mjs`: **141 passed, 0 failed**.
The focused additions cover district assignment, spare plots, stable pins,
migration, hidden reservations, alias changes, train intervals/car selection,
crossing timing, CI selection/attachment, crane bounds, growth effects and
outline ownership/disposal. `git diff --check` and module syntax checks passed.

Separate agents reviewed district persistence, building/CI geometry and railway
integration. Their findings on spark scaling, cloned outline disposal, repeated
parked-train rebuilds and repository-name casing were corrected before handoff.

## Observed browser preview acceptance

Headless Chrome used the bundled `ui/dev/mock.js` backend, served on loopback.
These are synthetic preview observations, not installed/native acceptance.

- Day/night, building growth and rotating cranes were captured before/after.
- A real canvas click selected an unbuilt repo. Its clone action opened the
  existing dialog with the correct repo selected. No real repository was cloned.
- Empty-plot dialogs opened on both district sides.
- A sampled train pass showed pre-arrival crossing lights, named cars and a
  night headlight. The elapsed clock was advanced for this deterministic check.
- Adding 16 synthetic repos expanded ring 2 to ring 4; every existing cell
  remained unchanged, both spare counts stayed above three, and track/island
  bounds matched. The existing expansion animation was active.
- Reduced-motion positions stayed identical across two observed times; signals
  were off. Low quality disabled both renderer shadows and railway casters.
- Spark flipped PC → Spark → PC. A contributor portal round trip restored exact
  home pins/cells and hid the railway while away. No browser errors were recorded.

At 1600×1000 with eight matching projects and the same camera, 3.5-second rAF
samples on an RTX 4090 Laptop GPU (ANGLE D3D11) measured:

| Preview | High quality | Low quality | p95 frame time |
| --- | ---: | ---: | ---: |
| Baseline | 59.942 FPS | 59.938 FPS | 16.8 ms |
| Updated | 59.940 FPS | 59.940 FPS | 16.8 ms |

This supports the 60 Hz preview target on this machine. It does not establish
performance on other hardware, large cities or an installed WebView.

## Local evidence

Evidence is retained under `local/city-07-evidence/` in the original checkout,
outside the branch's tracked files:

- `before-day.png`, `before-night.png`, `before-grow.png`, `before-crane.png`
- `after-day.png`, `after-night.png`, `after-grow.png`, `after-crane.png`
- `after-clone-dialog.png`, `after-train-night.png`, `after-train-detail.png`,
  `after-expansion.png`
- `workflow-reduced-motion.png`, `workflow-low-quality.png`,
  `workflow-spark-flip.png`, `workflow-contributor-island.png`,
  `workflow-home-return.png`
- `before-browser.json`, `after-browser.json`, `interactions.json`, `workflow.json`
- Reproduction scripts: `preview.cjs`, `interactions.cjs`, `workflow-check.cjs`

Publishing, installation and real project/owner workflow acceptance remain
separate steps. No release tag or installer was produced by this UI change.
