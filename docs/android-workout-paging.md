# Android workout paging

The workout reading region uses Compose Foundation's `HorizontalPager`. Each page derives its
name, planned targets, logged sets and previous-session history from its exercise id. The rack,
position dots and add control stay outside the pager.

Selection changes after the pager settles. Reversing a gesture preserves the selected exercise,
entered weight and reps, set kind and pending deviation eligibility. A completed change reseeds the
rack by exercise identity as well as prefill value, including two exercises with identical defaults.
Editing, logging and adding a movement wait until the page and selection agree.

## Structure and performance observations

- Gesture thresholds, direction locking, drag cancellation and snapping belong to the native pager.
  The domain holds the refusal wording; it has no gesture recognizer or pixel thresholds.
- Adjacent pages preload one previous-session result each through the same read/cache path as
  selection. A preview read does not change selection or prefill, and late replies are checked
  against the account, workout and transport before entering the cache.
- Vertical scroll and horizontal set-strip state belong to their exercise page. The set strip
  consumes leftover horizontal scroll and fling so reaching its end cannot change exercise.
- Fully offscreen page semantics are cleared. A visible incoming preview stays outside TalkBack's
  selected-page controls until it settles. The title retains Previous/Next movement actions.
- The pager uses the existing horizontal gutters and adds no system-gesture exclusion. System Back
  retains priority at the screen edge; the workout's existing Back handler keeps the workout open.

## Verification

The focused workout suite covers destination-specific previews, reversal and short-drag cancellation,
settled selection, draft and kind preservation, deviation prompts, accessibility actions, assembly and
picker navigation, and real vertical/set-strip scrolling.

An isolated Android API 34 emulator exercises a two-movement routine. A held drag shows both pages,
reversal preserves 22.5 kg and 6 reps, a completed swipe selects Barbell Row, and an edge Back gesture
keeps that exercise and workout open. The rack and action remain visible at font scale 2.0.

The final `./gradlew build -Pwindmill.apiBase=http://10.0.2.2:8088` succeeds, including lint and
1,021 executed tests in each of debug and release. Each normal run skips 12 opt-in live API cases.
All six pager-specific tests pass. The final emulator build also resets a completed move from an
edited 22.5 kg × 6 to the destination's identical initial default of 20 kg × 5, and logs the next set
under Barbell Row.

An additional opted-in live API run against the existing local server has seven passes, four failures
and one skipped magic-link case. The unchanged network tests expect no creation history on a routine
read and an ASCII apostrophe in the offline message; the latter assertion prevents closing a scratch
session and causes the cursor and cleanup failures. The temporary test account is deleted in a
finally block. Follow-up: dogfood node `gym-android-live-wire-expectations`.
