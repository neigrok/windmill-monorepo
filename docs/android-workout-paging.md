# Android workout paging

The workout uses one native Compose horizontal scroll owner over its body, including clocks,
blank space and rack controls. `HorizontalPager` renders the exercise reading region, while the
rack stays fixed. Each page derives its ledger — logged, current and planned sets — from its
exercise id. The page head (‹ name ›, `Exercise i / n`, clocks) is pinned; only the ledger scrolls
vertically, and Add movement sits at its foot.

Selection changes after the pager settles. Reversal preserves the selected exercise, persisted
rack draft and pending departure question. The store owns rack values across movement changes,
notifications and restarts. Editing, logging and Add wait until the pager and selection agree.
Android cancellation returns the page to the selected exercise. An external selection interrupts
the active drag before aligning the page, so old pointer events cannot leave the controls disabled.

## Structure and performance observations

- Native scrolling owns touch slop, axis arbitration, pointer transfer and snapping. The domain
  holds refusal wording, with no pixel thresholds or gesture recognizer.
- Each exercise has its own ledger scroll state. The ledger scrolls vertically only, so every
  horizontal stroke on the body pages exercises. A landed set, and a page becoming the selected
  one, bring the current row into view just above the rack.
- Fully offscreen semantics are cleared; incoming previews stay outside TalkBack's active controls.
  The head's ‹ › buttons step the walk, and Previous/Next movement actions remain on the selected
  title.
- Workout clocks, persisted rack and notification commands retain their current ownership. Paging
  draws no new sound, haptic, control or system-gesture exclusion.

## Verification

The Android 14 emulator check exercised a held rack-origin preview, reversal with a 22.5kg draft,
a completed swipe to Barbell Row, and edge Back without leaving the workout. The rack remained
fixed, no set was logged by the gesture, and the workout stayed usable at 200% font scale.

The full Android build passed for debug and release: 1,290 executed tests per variant, zero
failures, and 12 optional live-wire cases skipped by the ordinary build. All 18 release-tool tests
passed. The logger regressions cover held previews, reversal, equal-prefill moves, nested scrolling,
dynamic movement insertion, cancellation past the midpoint, and external selection during a drag
followed by enabled controls and another successful swipe.

The separate run against the local backend passed 11 live-wire cases with no failures. The
magic-link case was skipped because that optional credential fixture was not supplied.

## Android 0.9.2 release

[PR #5](https://github.com/neigrok/windmill-monorepo/pull/5) is merged. The published
[0.9.2/code93 release](https://github.com/neigrok/windmill-monorepo/releases/tag/android-v0.9.2)
uses tag `android-v0.9.2` at `5a656915c5b1f3f5c94a5849c032e6e85835794a` and
[Actions run 35502208864](https://github.com/neigrok/windmill-monorepo/actions/runs/35502208864),
attempt 1. CI testing and signing-input assembly passed. Local signing retained the pinned
certificate and verified unchanged application contents and independently checked source/run
provenance. The APK is non-debuggable.

The signed APK updated 0.9.1/code89 in place on Android 14. Its two-movement routine, active
workout, logged 20kg×5 set and 25kg draft survived the update and restart. A rack-origin held drag
showed the adjacent page; reversing retained the selected movement and draft without logging.
Completed swipes changed movement and used the existing store prefill on return. A separate clean
install created a two-movement routine, swiped to Barbell Row, logged 20kg×5 and retained the saved
workout and routine after restart. Notifications stayed denied; authenticated Coach and spoken
TalkBack were outside this bounded final-APK check.

The anonymously downloaded APK, digest and provenance match the accepted signed files and GitHub's
asset digests. The public APK passes the full signature and linked-provenance check. Its SHA-256 is
`d23a429404035dfa0bfffc7eb1e6a32f33c7c2a27d0d155b533cc6e7491ee182`.
