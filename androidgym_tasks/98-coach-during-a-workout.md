# Coach answers during a workout on Android

**Status:** On the phone turn. Coach answers over the open workout, reads it, and proposes through `propose_workout_change`; the lifter applies from the card's review sheet (gym Coach §0, ledger 11k). The server's Ask refuses mid-workout with 409 `ask-session-open`, which only the web still meets.

**Figma:** 08.54, 08.55, 08.55b, 08.56, 08.57, 08.64, 08.65, 03.46.

**Current implementation**
- `GymRoom` offers Coach over the workout where its own tab would answer (`CoachSheetFrame`), and the `get_session` of the open workout joins the context reads.
- `WorkoutReviewBinding` decides a change to the open workout through the domain's workout-proposal actions, under `gym.applyWorkoutProposal` and `gym.dismissWorkoutProposal`.
- Web follows in its own task once its board exists.

**Depends on:** 28, design brief QW9. Tree: `coach-mid-workout-android-web`.
