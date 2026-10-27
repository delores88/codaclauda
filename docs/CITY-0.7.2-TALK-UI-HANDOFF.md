# City conversation presentation

UI-only follow-up on `86cfbda` (`codex/codaclauda-0.7.2-city-launcher`).
The existing Claude discovery fix and direct building-button session launch remain
in the ancestry. No provider, Rust, access, installation or release changes.

## Behavior

- The scene fills the available canvas, without letterbox elements. A chest-height
  side camera fits both full figures beside desktop chat or above the mobile
  sheet. Open stances show both faces. The final camera still checks walls,
  trees and lamps; clear views with no sign behind a head win otherwise equal
  candidates. Temporary scenery cutaways restore when the conversation ends.
  The front bias is 25 degrees for equal heights, easing toward 15 degrees for a
  shorter owner so a tall agent does not dominate the frame. Neither avatar is scaled.
  Seated agents stand at a clear spot on their own lot and keep their original
  bench reserved for Leave. If no safe spot exists, they remain seated.
  Individual planter bounds keep both talk spots out of planting beds. Scenery
  checks include knees and shoes. A passer-by covering a participant temporarily
  disappears from the shot and picking; its simulation continues, and its normal
  visibility returns when clear or on Leave. Other people remain visible.
- Only the two participants' floating status markers and selection rings hide
  during conversation. The current status returns on exit. Speech bubbles keep
  their exact speaker anchors; a working agent shows typing dots until its reply.
- One header row contains the avatar, ellipsized provider/project title, status,
  and icon actions. Routing details are in the status tooltip. The existing
  `onNewSessionHere(projectId, details)` contract is unchanged.
- A newly started building session with no messages shows the provider/project,
  the access from its actual session receipt, and project-specific starter chips.
  Any real transcript entry retires that empty state. Existing conversations keep
  their transcript and previous starters. No history is invented.
- Starting disables the composer and shows a spinner. A creation rejection shows
  its error with an explicit Retry. Dismissal never retries or reopens a session.

## Pending hook additions

The synchronous `enterTalk(id, { pending })` handle retains its exact generation,
`resolve` and `fail` semantics documented in `CITY-0.7.1-TALK-HANDOFF.md`.
It still starts, stops and sends nothing. The existing building caller supplies:

```js
pending: {
  provider, projectId, label: 'New session',
  fresh: true,
  retry: () => retryThroughExistingBuildingControls(),
}
```

`fresh` remembers only the exact admitted session as a fresh conversation.
`retry` is optional and appears only after a creation failure. The building caller
binds it to the current failed talk generation. It rechecks the current project,
This PC context and provider availability, then reuses
`BuildingSessionActions.start` and the existing owner `sessions.start` path.
Repeated clicks are serialized. Retry is a new explicit attempt; a successful
admission or a later send failure never triggers a second launch. Closing,
switching, remote/Spark context or deleting the project makes a stale retry inert.

The existing building drop-in, exact-session send path, board thread routing,
desktop labelled-copy flow and saved-camera restoration remain in place.

## Acceptance

Source tests and synthetic browser evidence are recorded separately from installed
acceptance. Browser captures use `ui/dev/mock.js`, a sanitized project list and a
custom owner avatar; no real provider is started or messaged. Evidence is kept
outside the commit at `local/talk-072-evidence/` in the main checkout.

`cd ui; node --test`: **501/501 passed**, no skipped tests. The focused framing
matrix includes the custom owner beside taller avatars, desktop and mobile
rectangles, three orientations, full-body clearance and speaker-facing checks.

Required captures: `talk-fresh-claude.png`, `talk-fresh-codex.png`,
`talk-starting.png`, `talk-history.png`, and `talk-mobile.png`.
The browser receipt checks actual building buttons, exact session reuse, pending
and Retry states, both faces and body bounds, marker restoration and the 300px
header. Installed/native/provider acceptance has not been run by this change.

## Signboard composition follow-up

The signboard check now reserves both complete head silhouettes and the maximum
speech-bubble band, using the same bubble layout and exact speaker anchors.
Explicit text metadata covers building/HQ plaques, side signs, unbuilt project
boards and tickers; mounted label meshes are also considered. Nontext canvas
textures are excluded. Visibility probes ignore distant text hidden by walls,
moving people and scenery that the selected shot will fade.

Safe standing positions and solid-wall clearance retain first priority, followed
by visible text overlap and then temporary scenery cutaways. Planter placement
margins no longer masquerade as solid camera walls; full-body geometry checks
still include the actual planters. The final side-camera checks replace the
obsolete shoulder-camera clearance when choosing an owner's talk spot.

When the initial project position has no quiet background, staging checks at most
six clear alternatives spread across the same lot. This runs once before arrival.
For a pending start, it updates the existing reservation in place before Ben drops
in; the exact admitted session joins that point, and Ben retains his arrival spot.
Reframing can adjust the shot without selecting another NPC anchor. A failed start
or missing reservation cannot move a synthetic pending agent. Existing placement,
project aliases, body clearance and bench-return behavior remain intact.

Follow-up evidence is separate at `local/talk-072-signs-evidence/` in the main
checkout. The requested `talk-fresh-claude.png` and `talk-history.png` use the same
mock bridge, sanitized project fixture and custom owner avatar. Earlier accepted
evidence under `local/talk-072-evidence/` is preserved.
