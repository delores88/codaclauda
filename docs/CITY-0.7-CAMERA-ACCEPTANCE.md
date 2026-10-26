# City 0.7 camera, Legend and Jump-to acceptance

Local branch `codex/codaclauda-0.7-camera2`, based on
`e60a36f91d7f5a27320635c9a4bef90a6da1cf43`. Recorded 2026-10-25 (America/Denver).
The earlier camera branch remains intact at `7a5214e`; this port is a single
combined change on the current City integration base.

## Behavior

- Overview fits actual slab and visible-face building bounds into the largest
  unobstructed rectangle, using the camera FOV/aspect and 7% projected margin.
  Navigation, the City card, open Machines/project panels, toolbar and expanded
  Legend are excluded. The same fit works on the Spark side after a flip.
- First load and Home fit the island. Expansion refits only when the owner's last
  input is at least 30 seconds old and no other camera mode owns the view.
  A skipped expansion invalidates overview mode so later HUD resize callbacks
  cannot cause a delayed refit. Home queued during a flip retains overview mode.
- Zoom-out scales to at least 1.5 times the fit, preserving saved manual/temporary
  camera poses. The orbit minimum remains 3. Pan is bounded by an island-space
  square with 12% margin so corner lots can reach the screen center.
- Focus centers rendered objects in the free viewport beside their panel.
  Buildings use an overhead view sized for about 35% of the available height;
  their full geometry still fits. Street view remains the close view.
- The integration base's boat-label picking and moving-target tracking are
  retained. Tracking ends when the centering flight lands or is interrupted.
  Street/talk modes retain their exact saved camera position, target and centered
  framing mode. `World.focusPoint({x,y,z}, {distance})` remains available for
  island-space integrations, including queued flips.
- Legend defaults to a small chip and remembers its state with guarded
  localStorage access. Expanded: four status dots on one row, short icon/label
  entries in two columns, at most 300px wide and 40vh tall, internally scrollable.
  Drag-to-assign instructions live in controls help.
- Jump-to lists Working now first, then Projects grouped by Downtown, Suburbs and
  Not on this PC, then Awake and collapsed Powered down. It provides search,
  counts, provider icons, project agent badges, You/HQ/Spark shortcuts, keyboard
  navigation and a full-width mobile sheet. Project panels list their agents.
- Narrow screens place the project panel below the focused building and keep the
  toolbar inside the visible screen.

## Source checks

`cd ui; node --test`: **272 passed, 0 failed**. `git diff --check` passed.
No Cargo command was needed. The original integration's camera and interaction
regressions are retained, including real OrbitControls updates, exact temporary
camera return, boat tracking and IDs, ghost/building/agent framing, and expansion
policy. New tests cover tight projected scene fitting, overlay-free rectangles,
focus scale, picker behavior, queued Home and destination-face limits.

`camera.js` contains the camera math implementation. `camera-math.js` provides
compatibility exports for existing callers. Independent review found and fixed
queued Home losing overview state, HUD layout changes bypassing the expansion
input grace period, and pitch drift after restoring a shallow boat view.
The latter regression now covers 120 settled OrbitControls frames on both
underside settings and verifies that owner input releases the fixed angle.
No source review blocker remains.

## Browser preview

Headless Chrome served this worktree's `ui/` with `ui/dev/mock.js` on local port
5190. Data are synthetic. These observations are browser preview acceptance,
not installed/native or real-agent acceptance.

Evidence directory relative to the main repository:
`local/camera-07-camera2-evidence/`.

| Artifact | Observation |
| --- | --- |
| `camera-fit-small.png` | Eight-project fixture, entire island in free viewport |
| `camera-fit-expanded.png` | 33-project fixture, ring 6, entire island fitted |
| `camera-focus-corner.png` | Corner lot centered beside panel with neighboring lots visible |
| `camera-fit-spark.png` | Expanded Spark face fitted |
| `legend-collapsed.png` | Small default Legend chip |
| `legend-open.png` | Compact four-status/two-column Legend |
| `legend-open-mobile.png` | Legend within 390px viewport |
| `jumpto-open.png` | Working-first grouped searchable picker |

`viewport-review.json`: **8/8 checks passed**, zero page/console errors. Both
faces reach 93.46% of the free rectangle height. The focused building occupies
about 33% of free height. The run covers expansion suppression after input and
refitting on later growth after the grace period, Legend persistence and camera
projection changes for street/talk modes.

`growth-home-review.json`: **6/6 browser checks passed**. Home immediately followed
by growth from ring 4 to ring 7 holds the exact camera pose, including after resize
callbacks and after the grace period expires. Only a new Home action refits it.

`interactions-focus-api.json`: **12/12 checks passed**, zero browser errors.
Actual canvas/key events cover building double-click, ground walking, agent,
ghost and Spark focus, a rendered moving boat-label click, and exact street/talk
return from that boat view. The moving boat lands at the free viewport center;
both return checks report zero eye and target error. The public focusPoint API
is checked on both faces and during a queued flip. Boat screenshots are
`boat-label-focus.png`, `boat-street-return.png` and `boat-talk-return.png`.

Legend preview verified four status columns, two icon columns, the width/height
cap, internal scrolling and both stored states across reload. Desktop expanded
size is about 300x218px; mobile is about 286x218px. No page errors were observed.

`frame-cadence.json` records a current isolated high-quality preview sample at
1600x1000 with eight mock projects: **about 59.9fps**, median **16.7ms**, 120 animation
frames (119 intervals). This short headless sample is not a guarantee across
machines or larger cities. Camera bounds are evaluated on state or layout
changes, outside the ordinary animation loop.

`tests-final.txt` records the full unit run. Additional interaction evidence is
stored alongside these reports. Earlier camera evidence remains in
`local/camera-07-evidence/` and does not establish acceptance of this port.

## Integration boundary

Changes are confined to camera/controls, Legend, picker, their tests and this
acceptance record. River, boat, water, park and empty-lot rendering files are
unchanged from e60a36f. Existing boat selection hooks are preserved in `city.js`.
Concurrent river work still needs the integrator's combined preview checks.

Submit the camera2 commit and screenshots for design review before handoff.
No installation, publication or release acceptance is claimed.
