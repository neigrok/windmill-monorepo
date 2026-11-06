# A draft written signed out waits as Draft kept on this phone

**Status:** *Draft kept on this phone* (01.18) stands on main (`coach/CoachSetup.kt`, `LocalCoach`). Neither phone draws choice chips: the catalog has no `ask_setup_details`, so Coach asks in prose, and 01.17 waits to be retired (ledger 12i).

**Figma:**
- 01.17 Coach asks a choice, signed in: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-40111) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-40235)
- 01.18 Draft kept on this phone, signed in: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-40674) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-40774)
- System parts: M3 kit Filter chips, the kit text button; `Android / Chat bubble` `337:2761`.
- The shared wire authority is `backend/products/gym/domain/Thread.cpp:41` (`validClarification`) and `backend/products/gym/adapters/json/GymJson.cpp` (`clarificationFromJson`).

**Current implementation**
- Kept drafts live under the existing owner/chat identity in the same atomic Coach document. A draft includes text and a photo reference.
- Sign-in moves the phone draft only after a copied photo and its account reference are durable. An existing account draft keeps the phone's draft as the kept card.
- **Continue saved draft** swaps complete drafts, and tells `gym_action` `continue_draft`. The card displays text only; a photo-only held draft omits the text row and restores its photo through the composer.

**Ledger:** 12i; dogfood `android-gym-target-page`.
