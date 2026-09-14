# Windmill Gym for Android 0.8.0

The Android app now follows the refined Gym designs across Routines, training, Log and Coach.

- Create movements from a routine or a workout. Build per-set targets, fill a progression, reorder movements and keep drafts when a save is refused.
- Log planned or free workouts with editable numbers, an elapsed rest clock, independent Undo and recovery for sets saved offline.
- Read saved workout receipts, correct sets, explore movement records and bodyweight, and save a workout as a routine.
- Use Coach conversations, saved read details, Notes and explicit proposal decisions. Account changes preserve ownership of local training.
- Use the native workout notification to return to the logger and log the current set after unlocking. Dismissal stays respected; optional rest alerts use Android's notification controls.
- Switch between Daylight and Night, use larger text and native navigation/accessibility controls. Kind controls and set-confirmation sound or vibration are removed; historical classification remains intact.

This release also consolidates the application-owned workout runtime, atomic local storage, shared Coach presentation, receipt data and unused UI controls. Rest alerts depend on system notification and exact-alarm access; Android can suppress them, and a process failure can lose an alert. Training remains saved independently of the alert.

## Installing over an older APK

This release starts using a retained release signing identity. Earlier published APKs used different debug certificates, so Android cannot install this release over those installations.

Keep the old installation until every record you need is verified from another signed-in Windmill surface. Use the sync and ownership controls available in that version. If you cannot verify the records elsewhere, keep the old installation and do not uninstall it. Uninstalling an Android app removes its local data, including unclaimed or unsynced training; this release does not migrate that data across a certificate change.

Future APKs signed with this retained identity can use Android's normal update path. The release includes its SHA-256 and provenance, with public certificate SHA-256 `e911c90024117df99a2852a0d7820889e3d8a399506a8557148af7171c63e2bb`. Private signing material stays on the release machine.
