# 01 · From a November tester invitation to a December App Store install

**November 12–18.** The founder checks the invitation before recruiting ten lifters. Today’s iOS
TestFlight app carries Gym and Journal. The signed Android APK carries Gym. The 20-builder Ship v1
pilot uses Roadmap on the web. Keep both pilots running while preparing the public iPhone release.
[Product roles](../../PRODUCT_LOG.md) · [Gym cohort](08-gym-demand-cohort.md) · [Ship v1 pilot](11-roadmap-seed-trees.md)

1. Follow the TestFlight invitation on a supported iPhone as an external tester. Install the build offered
   to that group, open Gym, log a set and find it in history. [TestFlight](https://developer.apple.com/testflight/)
2. Follow the signed APK link on a supported Android phone, verify the published digest and repeat the
   first-set check. Tell participants it is a sideload before they accept. [Android releases](../../../apps/android/README.md#ci-and-releases)
3. Record date, platform, build, destination and the outcome. Recruit on each route once it passes. Exclude
   internal checks from both pilot counts. If installation fails, fix access before interpreting demand.

## Public iPhone release in early December 2026

December 1–5 is an internal working window. The founder owns the public listing and records these steps
separately, so an invite or announcement can always point to something the reader can use.

| When | What to prepare or verify |
|---|---|
| November 12–18 | Choose intended storefronts. Outline the Roadmap story and collect support and privacy links, reviewer instructions and sign-in details where required. Record who can submit the build and who will check the live listing. [Listing brief](05-aso-and-featuring.md) · [App submission](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-app/) |
| Before submission | On the candidate iPhone build, mark a Roadmap step complete, close the app, reopen the tree and verify that the same step is still marked complete. Check the Journal and Gym actions named in the listing. Capture the build number and screenshots with founder-owned example data. Coordinate any subscription submission with the owner’s chosen sales channel. [Windmill One readiness](04-gym-demo-and-checkout.md) |
| At review | The release workflow uploads the archive to App Store Connect and checks TestFlight availability. Select the candidate for public App Review, submit the matching materials, track the review decision and record the release option for that version. [Release workflow](../../../.github/workflows/ios-release.yml) · [Apple release options](https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/select-an-app-store-version-release-option/) |
| On public availability | Open the public product page in each storefront named in the announcement. Download the app on a supported iPhone without TestFlight, verify the version, then repeat the completion and reopen check before announcing native Roadmap. Record storefront, URL, date, version and result. Publish each store link after its download passes. |

If the public listing is pending, invite builders to try Ship v1 on the web and send beta testers the
tested TestFlight invitation. If the native Roadmap check fails, take the result to the owner for the
release decision. Describe only the rooms demonstrated on any build the owner releases. If payment
verification is pending, keep the message on the free actions available in that build.

Android’s distribution target remains the signed Gym APK. For a future Play release, check the account
type first. Personal accounts created after November 13, 2023 need a closed test with at least 12 testers
opted in continuously for 14 days before applying for production access.
[Google Play testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en-419)
