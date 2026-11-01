# Play Store distribution: a decision for the owner

**Status:** Waits for the owner's decision. No developer work starts until it is made.

**Context:** Android ships by sideload from GitHub Releases. People who will not sideload cannot find or install the app, and updates reach only those who see the in-app prompt. Listing on the Play Store changes reach and trust, but also signing, policy obligations and the release cadence. That trade is the owner's to make.

**Current implementation**
- `apps/android/README.md`: "Distribution is by sideload." Releases are signed locally with a retained key whose certificate `apps/android/release-signing.json` pins, and `tools/release.py finalize` produces the published APK.
- The app's update destination is `-Pwindmill.updateUrl=https://github.com/neigrok/windmill-monorepo/releases/latest`. A 426 shows *Update required*.
- Account deletion is in the app (task 48).

**What the owner decides**
1. Stay on sideload only, list on the Play Store, or do both.
2. If the Play Store:
   - **Signing:** whether Play App Signing takes the existing release key, so current sideloaded installs can update from the store. Confirm with the current Play Console flow before relying on it.
   - **Policy:**
     - a Data safety form that matches `docs/ANDROID_OBSERVABILITY.md` (Sentry, the first-party event intake, no content);
     - the account deletion web link Play requires beside the in-app path;
     - the privacy policy URL;
     - the target API level.
   - **Update path:** where *Update required* and the update prompt point for store installs, and for sideload installs.
   - **Track:** internal testing first, with the release test account (task 82) in the acceptance run.
3. Who holds the Play Console account and the upload key.

**Change** (after the decision)
- Record the decision in `docs/PRODUCT_LOG.md` and `apps/android/README.md`'s release section.
- If the Play Store is chosen, file the build work (an AAB in `android.yml`, store listing assets for the designer, the update URL per channel) as numbered tasks.

**Done when**
- The owner's decision is recorded, and any build work is filed as tasks.

**Depends on:** 82 for the store track's acceptance. Tree: `android-play-store-decision`.
