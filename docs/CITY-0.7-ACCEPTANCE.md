# City 0.7 UI acceptance

Prepared 2026-10-25 on `codex/codaclauda-0.7-city`, in the isolated
`local/worktrees/07-city` worktree. This river correction builds on `e60a36f`
and retains modern Suburbs, the continuous river circuit and camera refinement.
The separate parks and camera/picker ports still require combined integration.

Implementation and independent source review are complete. The stable-source UI
suite passed **249 tests, 0 failures**. Final headless workflows, visual inspection
and performance checks passed. Earlier checkpoint previews remain historical
evidence, separate from the final combined results recorded here.

This is local UI work. No push, installer, installation, release, publication,
Marketplace admission, native desktop acceptance or real-owner workflow
acceptance is claimed. No Rust or external-project changes are included.

## Implemented behavior

### River, terrain and district placement

- The river follows the original gentle cosine across the island along x:
  `z = -12 - 2.5 * cos(x / 17)`, with an approximately 11-unit water width.
  The fixed centre clears the existing HQ and Spark Foundry without moving them.
  Expansion exposes more of the same curve without moving its existing interior.
  Both districts gain rows together and their usable lot totals differ by no
  more than one row. Correct, safe pins stay in place.
- Downtown has a stone quay, railing and warm lamps; Suburbs have grassy banks,
  rocks and reeds. Water is recessed 0.9 units below road height. Terrain is
  physically cut on both faces, including the mirrored Spark deck; the underside
  banks remain supported when the optional Spark deck is hidden.
- The river forms a closed circuit across the PC face, around a downstream
  waterfall, along the underside, and around an upstream waterfall. Joining
  surfaces close the gaps between the square island rim and angled waterfall
  lips. Boat position and orientation remain continuous at all four joins.
- Water uses toon shading, outlines and a subtle surface wave. Night reduces
  motion and adds warm quay reflections. High quality includes narrow white
  ripples and waterfall foam; low quality removes those effects and river
  shadows. Reduced motion freezes the water and hides moving ripple/foam effects.
- Each crossing street has one perpendicular supported stone bridge, with a
  humped profile and no intersecting bridge decks. Clicking a bridge targets its
  actual deck; walking uses supported approaches and surface
  heights. Outlet streets remain cut until both bridge approaches fit on the
  island. Water targets near an outlet cannot route a walker beyond the island.
- Placement checks the complete lot and sidewalk, with an extra one-unit margin,
  against the water and banks. Unsafe or district-mismatched saved pins migrate
  once. Safe pins, aliases and hidden reservations survive reload and expansion.
  Each district retains at least three available empty plots.
- Home-city expansion preserves terrain, roads, banks and bridge alignment;
  dust and new-building rise animations show growth. Water and bank clearings
  cannot be chosen as project plots. Scenery excludes the complete footprints of
  bridges, banks and occupied Suburbs yards.

### Continuous boat fleet

- Two or three vessels remain on the circuit and keep equal spacing. Initial
  high quality uses three slots; initial low quality uses two. A later quality
  change preserves the existing slot count, phase, types and project labels.
- A shuffled six-type bag supplies replacement types only as a slot completes
  its upstream lap. Ordinary updates and quality rebuilds consume no type
  choices. Boats are not removed midway along the river.
- The original outlined models are a white 2.2-unit sailboat with a 1.6-unit mast
  and cream/violet sail; a wooden 1.4-unit rowboat with a rower and moving oars;
  a red 1.8-unit tug with white cabin, black funnel and high-quality smoke;
  a green 3.6-by-1.2-unit barge with two to four crates; a cream 3-unit two-deck
  steamer with twin stacks and a rotating red sternwheel; and a yellow 1.6-unit
  canoe with a paddler alternating strokes. Lengths describe the hulls.
- A non-barge has a 50% chance of carrying one recent project label. Barge crates
  carry distinct recent project labels where available. A valid commit date must
  be within 24 hours; a positive weekly count is the fallback when no valid date
  exists. No activity produces unlabelled craft, not invented activity.
- Labels retain physical hull boards or individual crates and add upright
  camera-facing project names with 12-pixel text on both faces. Labels respect
  nearer geometry when rendering and picking, and keep the boat's stable focus
  identity across model replacements. Moving oars and wheels retain supported
  pivots. Warm navigation lights respond to night.
  Low quality simplifies every model and has no smoke, bobbing or shadows.
- Reduced motion moors a barge and sailboat at the docks on each face, with no
  rig, smoke or bob animation. Mooring entries and positions survive quality
  rebuilds; actual project-manifest changes may refresh the labels.
- Models, outlines, private materials and label textures are released on
  replacement or removal. No sound is used.

### Suburbs and retained City behavior

- Local-only projects use four deterministic lot-selected modern homes:
  cantilever, L-shaped ranch, split-level and townhouse pair. Light stucco,
  charcoal roofs, large dark-framed windows and a wood entry accent distinguish
  them from Downtown towers.
- Homes have at most two storeys. Larger projects widen wings and garages
  instead of adding height; the house, yard and activity geometry fit the lot.
  Each home has a street-facing garage and driveway, lawn, one or two trees,
  low fence and warm modern wall lights. Trees clear entry walks and driveways.
- An active agent adds a small contractor van, amber beacon, supported ladder
  and solar-panel glints. Homes do not use tower cranes or scaffolding. Reduced
  motion keeps the lights steady and settles an in-progress footprint expansion.
- Home walking heights match the rendered lawn, path and driveway. Collision
  follows individual offset wings and the active van while leaving courtyards
  accessible. Roof tickers and CI markers use an actual supporting roof block.
- Downtown retains glass towers and planted plazas. GitHub-only repositories
  use pale ghost volumes at 83% nominal height and 23% opacity, supported ground
  signs, and no rooftop ticker or CI effects. Their panels retain Clone/Link
  actions; this update does not itself clone any repository.
- Real buildings retain roof tickers and the red CI-failure beacon. CI never
  creates clouds or rain. Tower cranes have no detached loads, and construction
  effects follow the building's current scale.
- Contributor islands retain their established architecture and layout; the
  river is hidden while visiting them. Spark buildings, jobs and flipping remain
  available with the matching river cutout. Help and legend describe the final
  districts, bridges, loop, boats and CI marker.

## Design reconciliation

All moving slots share one travel speed to preserve exact equal spacing. The
mean relative speed of the current type mix weights the fleet's target: barges
and steamers bias it slower, canoes faster. The target lap is 240–360 seconds,
but physical speed is clamped to **0.8–3 world units per second**. On very short
or very long routes the clamp takes precedence, so the actual lap can fall
outside four to six minutes. The policy returns both target and actual duration.

The bridge roadway rises to **y = 1.6–1.7**, above the nominal +1-unit rise,
while its approaches meet the road at **y = 0.14**. This reconciles supported
road ends with the tall sailboat. Water is **y = -0.76**; the conservative model
envelope is **1.84 units above water**, including outline and maximum bob.
With the 0.18-unit bridge slab, minimum clearance is **0.34 units**, exceeding
the 0.3-unit clearance requirement. The measured tallest animated model reaches
approximately 1.822 units above water.

## Automated tests and independent review

Final full-suite command, run from the worktree `ui` directory:

```text
node --test
249 passed, 0 failed
```

Coverage includes fixed curve extrema, normal-width sections, full-footprint
placement, safe-pin migration, spare plots and expansion; perpendicular bridges,
surface heights, picking and dry routes; continuous loop phases and type rotation;
all six model dimensions, animations, mounted labels, quality/reduced-motion
stability and disposal; and all four Suburbs variants, growth, collision,
walking heights, roof attachments and resource ownership.

Independent review checked the terrain, scenery, Spark reversal, navigation,
renderer lifecycle and model geometry. Findings corrected before final preview
include unsupported underside banks without Spark, bridge target identity,
outlet routes extending beyond the island, resampled reduced-motion labels on
quality changes, and gaps at angled waterfall lips. No blocking source/test
findings remained after re-review.

Additional geometry evidence includes 960 model/quality animation-envelope
samples; 5,000 orthonormal loop-frame samples; physical ray tests across both
waterfall joins and both faces; and actual underside-bank support rays with no
Spark deck present. Spark deck world-coordinate checks found no water intrusion
among 20,082 sampled vertices. These are source/geometry checks, not browser or
installed acceptance.

## Gentle-path correction acceptance

Independent review covered the periodic path and bounded street cuts, HQ and
Spark Foundry footprints, bridge clearance, minimum initial size and gradual
growth. Rendered HQ/Foundry geometry clears both water and bridge approaches.
Boat names remain at 12 pixels across camera distances and viewport sizes;
tests raycast every name row against actual opaque boat geometry from four
directions on both faces and both quality modes. Names no longer hide behind
their own cargo. Transparent smoke has no opaque outline shell.

The final correction suite passes 249 tests. Headless Chrome verified day/night,
the waterfall loop, six model silhouettes, Spark-side names, sailboat passage
under a bridge, bridge walking, reduced motion, Low quality and expansion.
Actual new billboard clicks focused the correct boat on both faces. Empty plots
opened Create/Link and a ghost opened Clone with the correct repository, without
performing those operations. No browser errors occurred.

The preview's six Downtown and two Suburbs projects start at ring 3: 14 and 21
usable plots, with 8 and 19 free. One fresh linked project starts at ring 2:
5 Downtown and 10 Suburbs plots, with 4 and 10 free. One local-only project also
starts at ring 2, leaving 5 and 9 free. Each preceding ring is insufficient.
Growth occurs one ring at a time when needed, never shrinks, and preserves pins.
Ring 3 through 7 totals differ by exactly one row, satisfying the agreed balance.

Evidence is in `local/city-river-correction-evidence/`: `preview.json`,
`billboard-click.json`, `interaction-check.json`, `boats-sheet.json`, the adjacent
reproduction scripts and `ui-tests.txt`. Images are also copied to
`local/city-07-evidence/`, including `overview.png` (first load), `river-day.png`,
`river-night.png`, `river-waterfall.png`, `river-spark.png`,
`river-bridge-boat.png`, `river-boats-sheet.png`, `river-expansion.png`,
`river-reduced-motion.png`, `river-reduced-spark.png` and `river-low-quality.png`.
The final 3.5-second headless samples measured 59.94 FPS in High and Low with
16.8 ms p95 on the previously documented GPU. This remains synthetic preview
evidence, not sustained installed performance or native acceptance.

## Earlier continuous-loop preview (historical)

The combined update was exercised in headless Chrome with synthetic
`ui/dev/mock.js` data on loopback. The final retained run recorded these results:

- Actual canvas clicks reached bridges in both street directions. Empty plots
  opened Create in Downtown and Link in Suburbs. A ghost sign opened Clone with
  the correct repository selected; no clone/link operation was performed. Water
  was not selectable as a project plot.
- Expansion grew ring 4 to ring 7, with 15 free Downtown plots and 115 free
  Suburbs plots. Every existing pin remained fixed, complete new footprints were
  dry, the original curve stayed fixed, and river/island half-width reached 125.5.
- Reduced-motion and low-quality checks passed. Spark flipped to its underside
  and back. Contributor trips beginning on a bridge and in Downtown preserved
  exact home pins and cells on return.
- The completed workflow runs reported no browser errors. Day/night, boat,
  bridge, waterfall, underside and Suburbs captures were retained for inspection.

Final visual inspection confirmed clean waterfall joins without filled black
outline wedges, an attached boat midway around a waterfall, a visible Spark-side
boat and label, and sailboat clearance below a bridge. Open water surfaces use
thin owned perimeter outlines. The 13 focused loop/renderer tests also pass,
including physical seam rays and outline disposal.

The final run used a fixed synthetic fixture and camera, a 1600x1000 viewport,
device scale 1, three boats, and an RTX 4090 Laptop GPU through ANGLE D3D11.
Sequential 3.5-second animation-frame samples recorded:

| Quality | FPS | p95 frame time | Maximum frame time | Draw calls | Triangles |
| --- | ---: | ---: | ---: | ---: | ---: |
| High | 59.94006 | 16.8 ms | 17.2 ms | 1,629 | 1,113,250 |
| Low | 59.94177 | 16.8 ms | 16.8 ms | 1,452 | 900,708 |

These figures are recorded in the final `preview.json` receipt. Short headless
samples establish behavior only on the measured machine, not sustained
large-city or installed WebView performance.

## Camera refinement and acceptance

Home and H now fit the complete island using its half-size, the camera field of
view, viewport aspect and all projected volume corners, with a 10% framing margin.
The volume also covers rooftops and the river rim. The initial view uses the same
fit, with no fixed overview-distance cap. Maximum zoom-out is at least 1.3 times
that fit distance; the far plane scales too. Square pan bounds extend beyond the
island by 10% or four units, preserving access to corner lots on both faces.

Expansion refits when the owner has not moved the camera during the previous
30 seconds. A skipped expansion does not schedule a later surprise reset.
An overview refits when the viewport changes; a manually positioned camera keeps
its pose, including its existing distance when narrowing zoom limits would
otherwise cause OrbitControls to snap inward. Minimum zoom and street controls
retain their existing behavior.

F, Jump and building double-click focus rendered bounds, including homes and
unbuilt ghosts. Exact centering remains stable after controls update and after
returning from street or conversation views. Ground double-click still walks.
Boat plaques resolve stable slot IDs across model replacements and center that
boat from a steeper angle that clears the quay; an active focus flight updates its target until landing without enabling
permanent following. Picking respects the visible face and nearer occluders, including both sides of
the river banks; clicks cannot select plaques through a quay wall.

The camera checkpoint had **240 passing tests**. Independent review covered camera
projection, both-face pan bounds, actual OrbitControls updates, the 30-second
boundary, manual/overview resize, click event ordering, temporary camera modes,
focus bounds, boat label picking, replacement IDs and disposal. Review findings
were corrected and re-reviewed before the local handoff.

Headless Chrome at 1600x1000 verified initial fitting, H/Home, automatic ring
4-to-7 expansion fitting, a centered corner ghost through Jump and double-click,
F on another ghost, agent focus, Spark fit and focus, portrait fit, resize without
moving a manual view, pan limits, and ring 7-to-8 expansion with recent camera
input preserved. Actual boat-label clicks centered their boat. Ground double-click
walked the avatar without opening a new-project dialog. Street and conversation
round trips restored the exact focused target and distance. Reduced motion, Low,
Spark flipping and contributor round trips also passed. No browser errors occurred.

New camera evidence and reproduction scripts are under
`local/city-camera-evidence/`: `camera-preview.json`, `focus-return.json`,
`workflow.json`, `ui-tests.txt` and their adjacent `.cjs` scripts. The final captures
are also copied to `local/city-07-evidence/`:

- `camera-fit-small.png`
- `camera-fit-expanded.png`
- `camera-focus-corner.png`
- `camera-fit-spark.png`
- `camera-fit-portrait.png`
- `camera-focus-boat.png`

The earlier river/model images and performance samples below describe their
historical river checkpoint; the camera images and 240-test suite record the
subsequent camera revision. The correction evidence above supersedes the old
river path captures. All browser evidence remains
synthetic headless preview acceptance, not installed/native acceptance.

## Local evidence and brief history

Current evidence is kept outside tracked files under
`local/city-loop-evidence/` in the original checkout:

- `river-day.png`, `river-night.png`, `river-boats-sheet.png`,
  `river-bridge-boat.png`, `river-bridge-click-x.png`, `river-bridge-click-z.png`
- `river-waterfall.png`, `river-spark.png`, `river-reduced-motion.png`,
  `river-reduced-spark.png`, `river-low-quality.png`, `river-expansion.png`
- `suburbs-day.png`, `suburbs-night.png`, `after-clone-dialog.png`,
  and the `workflow-*.png` captures
- Reproduction and receipts: `preview.cjs` / `preview.json`,
  `boats-sheet.cjs` / `boats-sheet.json`, `interaction-check.cjs` /
  `interaction-check.json`, `workflow-check.cjs` / `workflow.json`, and
  `moorings.cjs` / `moorings.json`; `ui-tests.txt` retains the full suite output

The final review images are also copied to `local/city-07-evidence/`, including
`river-*.png`, `suburbs-day.png`, `suburbs-night.png`, and `overview.png`.

Earlier local checkpoints are retained only for comparison: `53e721d` refined
ghosts and plazas; `9ff9a00` introduced the first river; `663623a` introduced six
boat silhouettes; and `732b4a5` completed modern Suburbs. Their evidence remains
in `local/city-07-evidence/`, `local/city-river-evidence/`,
`local/city-boat-variety-evidence/` and `local/city-suburbs-evidence/`.
Earlier preview timings and acceptance results do not apply automatically to
this final combined revision.
