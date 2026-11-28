# roadmap/coach

The words the model reads in a Roadmap Coach turn ([Roadmap Coach](../../../../docs/foundation/roadmap-coach.md) §8,
R-8), written with the owner. They hold no secret, and a person can read them here. The iPhone's App carries this folder
as it is, as a resource its Coach profile reads; the web's will, as gym's apps ship [gym/coach](../../gym/coach/README.md).
The owner approved `first-content.json` and `refusals.json` on 2026-11-28; a Debug build with Coach switched on reads them.

| File | What it holds |
|---|---|
| `prompt.md` | The system prompt of a turn, byte for byte. |
| `first-content.json` | The words of the turn's first content: `contextLeads`, the sentence that leads the context, `roadmap` for a conversation about one roadmap and `allRoadmaps` for one about all of them; `earlierConversation`, the line that marks the earlier conversation and the name each speaker goes by in it; `pictureOnlyQuestion`, the question that stands for a picture sent with none. |
| `refusals.json` | The sentence the model reads beside each refusal code: the gate's, `product-refused`, and every code of §6.1. |

## How the first content is put together

One user message, in this order:

1. When the conversation has history, one text block: `earlierConversation.marker`, then for each message, oldest first,
   `"\n\n"`, the speaker's name (`person` or `coach`), `": "` and its text; at most the last 24 turns and 24,000 bytes.
2. The context (§5), one text block: its lead, `"\n"`, and the context in canonical form.
3. The pictures.
4. The question as one text block, or `pictureOnlyQuestion` when the question is blank.

A refused call reads `{"code", "message"}`, the message the sentence beside its code here.

`receipts.json` holds what a person reads, not the model: each case a direct write's receipt as its Coach message records
it (roadmap-coach.md §9), and the line the conversation shows of it, in English, at most eight words. The web claims it in
`web/test/products/roadmap/coach/receiptLine.test.js`, the iPhone in its App's unit tests.
