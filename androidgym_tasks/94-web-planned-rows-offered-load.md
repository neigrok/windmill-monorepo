# Coach's workout panel on the web reads the load the plan expects

**Status:** Superseded by Coach during a workout on the web (WD7). Coach is open beside the rack and over it, so the
panel this task changes is gone, and with it the last web reading of a planned row as *last × max*; the workout page's
ledger reads the load the plan expects through `Prefill.expectedLoads`, as the phones do.

**Figma:** WD7 on the Gym file's Web page (`2150:11627`), approved 2026-11-25. The phones' rule is drawn on 03.34
([Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-40960)).

**Context:** Android, iOS and the web's workout page (`web/src/products/gym/workout/`, WD2) read a planned row at the load
the plan expects (*100 kg total × max*, or *— × max* while last time is unread), never a set logged today, through the
domain's `Prefill.expectedLoads`. Coach's workout panel on the web still reads *last × max* (ledger 11v).

**Current implementation**
- Coach's workout panel draws slot rows through `slotRows` and `setReading`, which print `'last'` and `'max'`
  (`web/src/products/gym/coach/coach.js`, `web/src/products/gym/log.js`).

**Change**
- The panel's planned rows read `Prefill.expectedLoads`, as the workout page's ledger does, in the form WD7 draws.
- Remove the 11v *Web planned rows* line from the ledger in the same change.

**Done when**
- A web test shows the panel's planned row as *100 kg total × max* with last time's last load 100, whatever was logged
  today, and *— × max* before last time is read.

**Depends on:** WD7. Tree: `web-mirror-planned-rows-offered-load`.
