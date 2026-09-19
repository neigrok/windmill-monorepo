# Gym feedback implementation plan

Status: feedback delivery is complete; PR #3 is merged. Backend and web deployments passed at `a21a4fd92a6722b170e2345949059e2ed01b36af`, with public endpoint and asset checks making no model requests. [Android 0.9.0/code85 is published](https://github.com/neigrok/windmill-monorepo/releases/tag/android-v0.9.0) after tag CI attempt2, retained-key APK verification, bounded clean-install acceptance and the offline 0.8.2 upgrade with records preserved after restart. Public downloads match the accepted files and pass APK verification. Tests and automation use deterministic LLM fakes/fixtures only; actual-model interaction is manual and local only with a user-provided local key. The [execution log](gym-feedback-execution.md) records evidence and acceptance limits.

The feedback comes from an Android app user. Android is the primary implementation and acceptance target, including the overall UI audit and final release. Shared Coach behavior belongs to the gym backend. The implemented web and iOS clients retain compatible conversation behavior; their secondary acceptance limitations are reported separately. Native apps retain workout logging; web retains its read-only live workout mirror. This plan preserves the dependency rule in [STRUCTURE.md](../STRUCTURE.md).

## Work and sequence

| Feedback | Work | Priority / delivery | Dogfood task |
| --- | --- | --- | --- |
| 6 | Let Coach create a routine | P1 / wave 1 | `gym-coach-create-routines` |
| 2 | Copy either speaker's message | P2 / wave 1 | `gym-coach-copy-messages` |
| 7, 9, 10, 11 | Pin compact screen and state designs | P1 / wave 1 | `gym-feedback-ui-contract` |
| 3 | Resume any retained conversation | P1 / wave 2 | `gym-coach-resume-conversations` |
| 8 | Show workout time and time since last set | P1 / wave 2 | `gym-workout-two-clocks` |
| 7, 9, 10, 11 | Implement and audit quieter gym screens | P1 / wave 2 | `gym-feedback-quiet-ui` |
| 4 | Stream Coach answers | P2 / wave 3 | `gym-coach-streaming` |
| 1 | Send pictures to Coach | P2 / wave 3 | `gym-coach-picture-messages` |
| 5 | Apply the supplied friendly, helpful prompt | Implemented; recorded output review accepted | `gym-coach-friendly-prompt` |
| Final delivery | Android release | Complete / wave 4 | `gym-feedback-android-release` |

P1 addresses blocked or confusing core use; P2 can ship alongside its prerequisite work when ready. Streaming and pictures depend on durable conversation turns. The two UI implementation tasks depend on the design contract. The prompt has no dependency on the other implementation tasks and does not block them; it precedes the final Android release unless the user explicitly defers it. Android release is the last item in the work sequence.

### Wave 1: useful Coach actions and a concrete UI contract

**Routine creation.** Expose the specific MCP routine-create operation to Coach, with existing Notes and relevant goals/equipment/constraints read first, movement-catalog reads before construction, and ordinary ownership/domain validation. Ask only for materially missing constraints; proceed when the user has already supplied enough context. Add movement creation only if catalogue inspection proves it necessary for a useful routine; do not grant every write tool. Pin request/turn identities before enabling creation. Persist the tool-operation identity and chosen routine ID before executing the write; reuse the existing same-ID creation replay and reconcile its structured result after a crash. Store the routine ID, result and receipt before answering so a reopened thread never depends on prose to recover the action. Repeated submission or a failed model response after creation must return the same created routine, not create another one. Existing routine changes continue through proposal review and human Apply.

Acceptance: “Create an upper-body routine” with sufficient goals and equipment context can produce a saved routine using valid catalogue movements, with a truthful creation receipt and a route to view it. Coach asks a relevant follow-up when material context is missing. Invalid references produce a recoverable error. An unrelated write remains unavailable. Retrying after the create operation succeeds produces no duplicate. If durable operation receipts are not yet available, their minimal persistence must land before this capability ships.

**Message copy.** Add a native long-press menu with Copy to both user and Coach text, including reopened history. On web, preserve text selection and expose a keyboard-accessible/context-menu copy action. Copy the message's text, without timestamps or hidden tool metadata. Keep copy available on partial text after a failed stream once streaming lands.

Acceptance: both speakers' text reaches the clipboard exactly, multiline and long messages work, and the action is accessible without a long press. Attachment-only messages do not offer an empty text copy. Proposal controls remain independently usable.

**Design contract.** The designer owns a screen/state matrix and updated Figma proposals for routines, active workout and Coach, then an overall gym pass. Measure content gaps and visual hierarchy separately on each surface. The feedback design contract pins Android routine rows at a 68 dp minimum with 4 dp gaps; use feature values rather than changing global spacing tokens. Keep minimum interactive targets at 48 dp on Android and 44 pt on iOS, and accommodate large text.

Coach's empty state should lead directly to the composer. Put History and New chat in normal navigation; place Notes and Connected log in a secondary destination/menu. Show limit or connection status when it affects the current action. Retain actionable errors, relevant read receipts and the result of a creation/proposal; collapse optional tool detail. Audit attachment, generating, interrupted, empty, loading, unavailable and resumed-conversation states, with the keyboard open and closed.

Acceptance: drawings pin the two clock meanings, all required state copy, navigation and accessible names before implementation. Review both skins, small screens and large text. Reuse the existing Android and web design work where it fits this feedback; separate proposals such as removing set kinds are outside this plan.

### Wave 2: durable conversations and quiet training screens

**Conversation contract.** Make history a route into the same editable conversation and composer. Keep retained conversations free of a lifetime question ceiling; ordinary account/day limits may still temporarily refuse a turn with an accurate retry path. Use cursor pagination for the complete conversation index and for messages as conversations grow, preserving access to the complete retained history. A retained conversation remains reachable and resumable regardless of its age or position in the index.

Keep complete stored conversation history separate from bounded model context. Define context selection/compaction on the backend so a long conversation can continue without sending every old message on every turn. Preserve durable references to created routines, proposals, attachments and factual tool receipts even when text is compacted.

Persist a client request ID, server turn ID, conversation ID, ordered message/event positions, generation state and completed side-effect receipts. Allow one active generation per conversation. Idempotent retries and reconnects must reattach to that turn. Persist completed tool results before proceeding so a rerun cannot mint a fresh routine ID or repeat a successful write. Keep the current JSON clients compatible while the richer contract is introduced.

Acceptance: resume a thread older than the first 200 results and send its fifth question; reopen after relaunch on another signed-in surface; preserve ordering and the same conversation identity. Duplicate sends, two simultaneous clients and a disconnect after a successful tool write yield one logical turn and at most one tool effect. Context trimming preserves full user-visible history and does not claim discarded text was consulted.

**Two clocks.** Use a compact, non-interactive row with distinct clock/stopwatch icons and legible tabular numbers. Remove drawn labels; retain accessible names “Workout time” and “Since last set”, with “Since start” before any set. Quiet means lower visual emphasis, not unreadable text or ambiguous semantics.

- Workout time is `max(0, now − session.startedAt)`.
- Since-set time is `max(0, now − latestValidSet.completedAt)`, falling back to `session.startedAt` before the first set.
- Use the existing wire timestamps `startedAt` and `completedAt` (native millisecond fields such as `completedAtMs`). The latest set is session-wide, across movements and all retained set kinds. Include locally accepted offline sets; a failed/unaccepted log does not reset the clock. Server acknowledgement does not reset it either.
- Changing movements, editing load/reps, backgrounding, relaunching and reconnecting preserve the original anchors. Deleting the latest set recomputes from the previous set or start; Undo restores its timestamp.
- Derive values from persisted timestamps, not accumulated ticks. Freeze both readings at the session finish timestamp. Pin clock-skew handling with the existing session-time contract.

Acceptance: both clocks are present immediately, read the same before the first set, and diverge after a set. Exercise switching, offline queueing, delete/undo, background/relaunch and finish retain the defined meanings. The web mirror uses the same semantics for records available to it and retains its connection/freshness status. This work does not restore a rest target, countdown or chime.

**Overall UI pass.** Implement the contracted routines, workout and Coach changes, then review routine detail/editor, movement picker, log/session detail, finish, progress and settings. Inspect empty, loading, error, offline/pending, overflow and large-text states as well as populated screens. Remove repeated titles, decorative labels, duplicate summaries and unexplained whitespace where the screen already conveys the fact. Keep necessary units, consequences, failures and reachable controls.

Acceptance: before/after captures demonstrate denser useful content with stable touch targets and no overlap at the supported small-screen and accessibility sizes. Core paths remain discoverable: choose/edit a routine, start/log/finish a native workout, inspect the web mirror, open/resume Coach and review a proposed change. File unrelated defects separately rather than absorbing an unrestricted redesign.

### Wave 3: streamed and multimodal Coach turns

**Streaming.** Stream incremental answer deltas through a transport supported end to end by the deployed backend, proxy and all three clients. Define ordered event IDs and start, delta, tool/result, completion and failure events against wave 2's persisted turn. Reconnection resumes from a cursor or fetches the authoritative turn snapshot; it must not replay already-rendered text. Show partial text as partial until terminal completion. Define Stop/cancel with a truthful terminal state; it does not undo completed tool actions. Follow new text only while the reader is at the end, preserving their position while they inspect earlier messages. Render no raw tool arguments or internal reasoning.

Acceptance: deterministic fixture output appears before the turn completes in the production-shaped local stack. Tool-assisted replies retain correct receipts. Stop/cancel, disconnect/reconnect, client backgrounding, proxy timeout and simulated provider failure do not duplicate text or tool effects. Scrolling earlier content is stable while new deltas arrive. A failed response preserves partial text and completed actions truthfully, and retry targets the same operation. Deploy the compatible server contract before clients require streaming; confirm proxy buffering and timeout behavior against the local fixture. Public deployment checks do not call a model.

**Pictures.** Add pick, preview, remove, send and reopen flows to the composer. Begin with one image per message; pin supported formats, dimensions and byte limits after checking the deployed model/adapter's vision support and each platform's picker output. Permit a picture with an optional accompanying question: the server accepts attachment-only turns with optional question text. Preserve text-first conversation titles; use a neutral title such as “Photo” for a picture-only first message, never the uploaded filename.

Store decoded, validated images in private owner-scoped attachment storage. Persist attachment IDs and metadata with messages, not duplicated raw base64. Enforce the same ownership on upload, model access and later viewing; check decoded dimensions and content rather than trusting the file extension. Define retention/deletion with the parent conversation and clean up abandoned uploads. Include a useful upload failure/retry state while preserving the draft.

Acceptance: a supported image can be previewed, removed, sent through the model adapter and reopened in the same conversation on another surface. Automated tests use deterministic image-response fixtures; actual image understanding is observed only through manual local model interaction. Unsupported/corrupt/oversized images produce an actionable error. Another account cannot fetch the attachment. Upload retry and turn retry reuse stable identities and do not duplicate messages. Validate interruption before upload, after upload and during generation, with streaming enabled and with a compatible non-streaming client.

### Independent: the supplied Coach prompt

The owner’s exact supplied text is installed, with compatible tool and data-boundary instructions. Coach reads user records before responding and can append a useful note through a durable, idempotent operation; it cannot edit, delete or reorder existing Notes. Recorded actual-provider text, image, routine creation and replay passed at `a3c3c811`, with explicit equipment variants and missing-pattern coverage accepted in manual review. Recorded note creation and replay passed at `3df4a889`; the final run did not choose a note. These are historical observations, not automated gates to rerun. Minor catalog narration and a photo answer’s empty-log aside remain copy observations, not rollout blockers.

### Wave 4: Android release

The final delivery is [Android 0.9.0/code85](https://github.com/neigrok/windmill-monorepo/releases/tag/android-v0.9.0), published on 19 September 2026 from `android-v0.9.0` at `a21a4fd92a6722b170e2345949059e2ed01b36af` and Android Actions run `35454444192`, attempt2. Its retained certificate, exact source/run provenance and unchanged application payload are verified; its SHA-256 is `ba7f2fd6de5fd15ba8b5808d810a817e23d138e794197b8e18a0207d7f2c94ed`. Android 14 clean-install checks passed for local routines, logging, both clocks, finish/restart and the signed-out Coach boundary. The offline 0.8.2 upgrade preserves routine, completed/active workout, preferences and queued-set identities after restart; timer origins consistently rebase after cold boot without changing their wall timestamps or interval. This does not establish network replay, final-APK authenticated Coach or full TalkBack coverage. Private signing material stays outside CI. The public APK, digest and provenance files match the accepted local files, and the downloaded APK passes the same verification.

The [Android release process](../apps/android/README.md#ci-and-releases) and [workflow](../.github/workflows/android.yml) separate CI build/test and signing-input provenance from local retained-key signing, native acceptance and publication. Distribution is by sideload. Delivery tracking: `gym-feedback-android-release`.

## Ownership and delivery gates

| Owner | Territory and responsibility |
| --- | --- |
| Designer | Relevant gym briefs/Figma state contract; per-surface density, copy and accessibility review; consistency-ledger resolution |
| Backend developer | `backend/products/gym`, relevant gym schema and mirrored tests: tool exposure, persistence, context, attachments, stream events and prompt |
| Android developer | `apps/android/gym`: composer/history, clipboard, streaming/media, routines/logger and native tests; Android app/CI release configuration, signed upgrade verification and final release |
| iOS developer | `apps/ios/WindmillKit` gym sources/tests: equivalent SwiftUI behavior and native verification |
| Web developer | `web/src/products/gym` and matching tests: Coach, routines and read-only mirror |

Pin the wire and state contracts in every parallel implementation brief. Give developers disjoint file ownership; changes to shared contracts/schema have one owner. Keep product-shaped mechanisms in gym unless an actual second consumer earns a platform abstraction. Within each surface, consolidate current and reopened message rendering so copy, attachments, action receipts and streaming states do not diverge.

Each implementation wave goes through adversarial diff review, one refactoring/simplification and fix pass, then meaningful contract/unit checks and local-stack verification using deterministic LLM fixtures. No test or automation calls a real model. Exercise native-only behavior on Android, including copy/pickers, accessibility, backgrounding and offline sets. Run regression checks for changed iOS behavior and report any remaining simulator acceptance separately; iOS authentication-fixture limitations do not block Android delivery. Validate owner isolation, retry idempotency and timestamp semantics with tests; validate spacing and text legibility with rendered screens. Resolve failures before staging/committing/pushing the affected repository work under the project workflow.

Update current-state docs and the consistency ledger as the behavior lands. Annotate the relevant dogfood nodes with actual verification, outcomes and follow-ups, and update progress only for completed work. Record structure/performance observations after each wave and address the material ones during simplification.

## Current contracts and acceptance limits

- [Coach wire contract](gym-coach-contract.md) defines durable requests/results, paged history, generation snapshots, streaming, Stop and private attachments. Backend and client implementation/verification status lives in [the execution log](gym-feedback-execution.md).
- [Feedback design contract](design/gym/feedback-contract.md) pins compact routines, the two clocks, quiet Coach navigation and image/streaming states. Its Figma links reference the updated drawings. Runtime acceptance remains separate from design completion.
- Full retained history and bounded successful-exchange model context are distinct. Adversarial review requires stable request identity through retry refusals and retained deletion records to prevent delayed requests from recreating deleted conversations.
- The owner’s replacement Coach prompt and durable note-save capability are implemented. Recorded output and tone review passed; note persistence has separate successful actual-model and deterministic lost-ack/replay evidence. Future real-model exploration is manual and local only.
- Local backend verification uses an isolated database and deterministic Anthropic-protocol fixtures. Backend and web deployments passed; Web Deploy is active and public assets carry the release source stamp. Read-only public endpoint checks passed without model calls; they do not verify authenticated public streaming.
- Android 0.9.0/code85 source/run provenance, retained-key signature, bounded clean-install checks, offline 0.8.2 upgrade preservation and public downloads are verified. The narrow 320 dp/200% text Routines tab-label clipping is recorded in the [consistency ledger](design/consistency.md); no flawless full layout matrix is claimed.
