# The web live mirror's planned rows read the load the rack will offer

**Status:** Waits for the designer to confirm the web mirror's planned-row text: design brief item QW7.

**Figma:** the web live mirror board QW7 names, once ✅ Ready for dev ([design brief](design-brief-quality-wave.md)). The phones' rule is drawn on 03.34 ([Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-40960)).

**Context:** Android and iOS planned rows read the load the rack will offer (*22.5 kg total × max*, or *— × max* while last time is unread). The web live mirror has no rack and still reads *last × max* (ledger 11v).

**Current implementation**
- Web's slot rows use `setReading`, which prints `'last'` and `'max'` (`web/src/products/gym/log.js:365-367,514-521`), drawn by `Mirror.jsx`.
- eff46ae9 moved the phones to offered loads and added `Prefill.offeredLoads` to web's domain (`web/src/products/gym/domain/trainingReads.js:154-157`). Web's UI does not call it.

**Change**
- The mirror's planned rows read `Prefill.offeredLoads`, formatted with the equipment-aware unit, as QW7 draws.
- Remove the 11v *Web planned rows* line from the ledger in the same change.

**Done when**
- A web test shows a planned row as *22.5 kg total × max* after a logged 22.5 kg set, and *— × max* before last time is read.
- The mirror matches QW7's board in both themes.

**Depends on:** 58, design brief QW7. Tree: `web-mirror-planned-rows-offered-load`.
