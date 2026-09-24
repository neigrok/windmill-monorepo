# Android Coach input

Coach uses Compose's state-based `BasicTextField` on the existing Foundation 1.8.1 dependency.
`TextFieldState` owns the editable text, selection, composition and undo history. The durable
`CoachDraft` stores only text and a photo reference. `CoachDraftEditor` keeps this boundary inside
`CoachComposer.kt`, scoped to the account and conversation.

One observer watches editor text, the store's draft version and the response visibility state.
Its synchronization path applies differing external text before saving pending edits. Send runs
the same path synchronously and proceeds only after saving succeeds, including when undo or redo
is followed immediately by Send. A failed save leaves the text visible with an error for retry.

External text replaces the editor only when it differs. Selection therefore survives photo changes
and unrelated draft notifications. While a response runs without an upload, the editor is empty
and disabled; the durable retry draft remains available. Ending that state restores the saved
text unless the response has cleared it.

The native editor and persistence belong together at this UI boundary. Keeping selection out of
`CoachDraft` avoids storage writes for caret movement, and using one synchronization path keeps
keyboard undo, touch edits and Send under the same persistence rules.

## Verification

Verified on 2026-09-24:

- `:app:assembleDebug` and `:app:lintDebug` passed.
- `:gym:testDebugUnitTest` passed: 1,245 tests passed, 12 optional `LiveWireTests` skipped, no
  failures or errors.
  This includes five Composer tests and 23 Ask screen tests covering touch selection, draft
  persistence, account and conversation isolation, save failures, and immediate undo/redo-to-Send.
- On an Android 14 emulator, double tap selected `bravo` in `alpha bravo charlie`; typing `delta`
  replaced only that word. Long press selected `alpha`, and keyboard undo and redo changed and
  restored the text. The stored draft and the draft after force-stop/relaunch were both exactly
  `alpha delta charlie`.
- Against the local fixture backend, a failed response retained the draft for retry. A streamed
  retry sent the current question and left the composer empty and disabled during the response.
  The response completed, the empty composer became editable, and the durable draft cleared.

Native acceptance used a separate emulator application ID; a physical device was not exercised.
