# Windmill Gym for Android 0.8.2

This update adds Sentry reporting for Android crashes, ANRs and handled failures, plus app, account, Coach and training events sent through Windmill to Amplitude.

- Errors identify the app build, operation and failure category. Coach timeouts are distinct from offline failures, with a longer bounded request budget.
- Product events cover screen use, Coach attempts and outcomes, workout starts/finishes, logged sets, routine saves and proposal decisions. Events queue on the device and retain stable IDs across retries.
- Unexpected Coach worker and telemetry delivery failures create Sentry Issues on the backend. Temporary Amplitude failures are retried.
- Telemetry excludes conversation text, training values, email addresses, credentials and response bodies. The privacy notice names the diagnostic and analytics processors.

The reported customer incident could not be reconstructed without incident details. This update adds instrumentation for future failures; it cannot recover telemetry from earlier versions.

Validation includes both Android test variants, live API round trips, the real Sentry SDK against a local HTTP collector, and backend delivery tests against local HTTPS collectors. Delivery remains bounded best effort; an app update is required to enable the new client instrumentation.

## Installing over an older APK

Version 0.8.2 uses the same retained signing identity as 0.8.0 and supports Android’s normal in-place
update. Keep the app installed and install the new APK over it to preserve local training.

APKs signed with older, different certificates cannot update in place. Keep the old installation
until every record you need is verified from another signed-in Windmill surface. If you cannot
verify those records elsewhere, keep the old installation and do not uninstall it: uninstalling
removes local data, including unclaimed or unsynced training. This release does not migrate data
across a certificate change.
