# Android workout paging

The workout uses one native Compose horizontal scroll owner over its body, including clocks,
blank space and rack controls. `HorizontalPager` renders the exercise reading region, while the
rack stays fixed. Each page derives its counter, planned and logged sets, and previous-session
history from its exercise id. Position dots and Add remain in the scrolling reading region.

Selection changes after the pager settles. Reversal preserves the selected exercise, persisted
rack draft and pending departure question. The store owns rack values across movement changes,
notifications and restarts. Editing, logging and Add wait until the pager and selection agree.
Android cancellation returns the page to the selected exercise. An external selection interrupts
the active drag before aligning the page, so old pointer events cannot leave the controls disabled.

## Structure and performance observations

- Native scrolling owns touch slop, axis arbitration, pointer transfer and snapping. The domain
  holds refusal wording, with no pixel thresholds or gesture recognizer.
- Adjacent pages preload through the same history cache as selection. Reads do not select or
  redial; replies are checked against the current authority, account, workout and transport.
- Each exercise has its own vertical and set-strip scroll state. The set strip consumes remaining
  horizontal scroll and fling, so its edge cannot change exercise.
- Fully offscreen semantics are cleared; incoming previews stay outside TalkBack's active controls.
  Previous/Next movement actions remain on the selected title.
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
