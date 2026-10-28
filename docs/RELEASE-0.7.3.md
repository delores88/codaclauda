# CodaClauda 0.7.3: automatic Spark bridge setup

When no Spark executable has been saved, loading the board now looks in the
ordinary Windows LocalAppData install locations for DGXBridge and RTXBridge.
Exactly one valid `bin/sparkdev.exe` is saved using the existing binding format.
This also runs on the existing board refresh, so installing the bridge after
CodaClauda starts does not require new setup UI.

Discovery does not run the executable and does not require the Spark to be
online. Existing bindings are preserved, including a missing or offline bridge.
Missing, ambiguous, inaccessible or package-cache-redirected candidates leave
configuration to the owner's existing **Save executable** control.

This release changes bridge discovery only. Finding and saving an installation
does not prove network connectivity, pairing or a successful remote workload.
The prior runtime executable-identity guard remains in place.

The installer and executables remain unsigned. The previously disclosed medium
glib 0.18.5 advisory GHSA-wrw7-89jp-8q8g remains; this update does not change
third-party dependency versions.
