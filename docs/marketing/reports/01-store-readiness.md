# 01 · Get a tester from invitation to first set

**Week 1, November 12–18.** The founder checks the native install path before recruiting ten lifters. The
iOS TestFlight app carries Gym and Journal. The signed Android APK carries Gym. Roadmap runs on the web. For
Gym, the signed-in web app serves planning, history, Coach and a live mirror. Send a lifter to a phone to
log workouts. [iOS release process](../../../apps/ios/App/README.md#testflight-releases) ·
[Android releases](../../../apps/android/README.md#ci-and-releases) · [Product roles](../../PRODUCT_LOG.md)

1. On a supported iPhone, follow the invitation as an external tester, install the offered build, open Gym,
   log a test set and find it in history. Check the build is available to the invited group. Apple documents
   external groups and beta review. [TestFlight](https://developer.apple.com/testflight/)
2. On a supported Android phone, follow the official release link, verify the APK against its published
   digest, install it and repeat the first-set check. Use the release linked in the Android README. Tell
   participants it is a sideload before they accept.
3. Record the date, platform, build, destination and pass or point of failure. Recruit for each platform
   only when its route passes. Keep internal checks outside the participant counts. If installations fail,
   diagnose access before interpreting workout demand. [Gym cohort](08-gym-demand-cohort.md)

**Production stores are a later distribution decision.** For each binary, identify an owner, check account
status and release fees, prepare accurate metadata, provide review access where needed, and request owner
approval for any spend. Apple separates TestFlight from production review. For a personal Play developer
account created after November 13, 2023, Google requires at least 12 testers opted in continuously for 14
days before applying for production access. Establish whether that requirement applies to this account. The
ten-person Gym cohort has a different purpose.
[Apple submission review](https://developer.apple.com/app-store/review/) ·
[Google Play testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en-419)

Publish a store badge only after someone in the intended region can open the listing and install the correct
public build. Record the verified URL and date. A review submission or successful upload leaves that check
open.
