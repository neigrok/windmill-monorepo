# roadmap/coach

The words the model reads in a Roadmap Coach turn ([Roadmap Coach](../../../../docs/foundation/roadmap-coach.md) §8,
R-8), written with the owner. They hold no secret, and a person can read them here. No app carries this folder yet:
the web's and the iPhone's Coach profiles will ship it as it is, as gym's apps ship [gym/coach](../../gym/coach/README.md).

| File | What it holds |
|---|---|
| `prompt.md` | The system prompt of a turn, byte for byte. |

`receipts.json` holds what a person reads, not the model: each case a direct write's receipt as its Coach message records
it (roadmap-coach.md §9), and the line the conversation shows of it, in English, at most eight words. The web claims it in
`web/test/products/roadmap/coach/receiptLine.test.js`, the iPhone in its App's unit tests.
