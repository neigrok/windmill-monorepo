# Coach answer links keep their destinations

**Status:** Reviewed, with one fix pass applied; `:gym` and `:app` unit tests are green. A mutation test proves that a long press on a link opens the menu and never the link. Not yet verified: on a device, a link opening in a Custom Tab, TalkBack reading a link, a phone with its browser disabled, live telemetry, and a comparison against boards 08.66 and 08.67 before they are marked 🚀.

**Context:** Coach needs separate readable and clipboard forms so History remains label-only while copied answers retain destinations. Only finished absolute http(s) links are actionable.

**Figma:** 08.66 links ([Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1849-29958), [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1849-29975)) and 08.67 Copy link ([Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1849-29992), [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1849-30104)), ✅ Ready for dev per the approved package handoff of 2026-11-03.

**Current implementation** (paths under `apps/android/`)
- `gym/…/coach/CoachMarkdown.kt` carries validated destinations in spans, balances destination parentheses, and shares line construction between readable and clipboard text. Streaming destinations stay plain; code stays literal.
- `gym/…/coach/CoachAnswer.kt` supplies URL annotations with the theme's primary role and underline, copies answers with destinations, and opens Custom Tabs through a non-throwing boundary. Missing browsers open the copy menu and emit only an expected outcome.
- `gym/…/coach/CoachBubble.kt` offers Copy link in the menu and accessibility actions only for one distinct full-answer link. Copy link writes the URL alone; a clipboard refusal keeps the menu open.
- `gym/…/telemetry/GymEvents.kt` and `docs/ANDROID_OBSERVABILITY.md` register bounded copy/open outcomes and the unexpected opening failure boundary.

**Done when**
- Parser, answer, bubble, handler and observability tests pass through the orchestrator's Gradle run.
- Native long press opens the menu without launching the link; TalkBack announces and activates links and offers Copy link.
- A disabled browser opens the approved copy menu without an Issue; live events and unexpected failure reporting arrive without content.

**Depends on:** approved 08.66/08.67 boards. Tree: `android-coach-answer-links`.

**Open**
- The orchestrator removes ledger 11z's D3 claim that `link()` drops URLs when that ledger lands from `review-wave-design`; this package does not edit the ledger.
- The orchestrator marks the approved boards 🚀 In production after verified merge.
- Several-link answers offer Copy answer only. Missing-browser fallback adds no explanatory sentence.

**Structure observations**
- Readable text and clipboard text share traversal and differ only in span rendering, keeping table/list handling consistent while preserving History's contract.
