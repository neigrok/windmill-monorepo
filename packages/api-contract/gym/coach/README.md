# gym/coach

The words the model reads in a gym Coach turn ([gym Coach on the AI service](../../../../docs/foundation/gym-coach-on-ai-service.md)
§3, R-8). They hold no secret, and nothing is filled into them at run time but the places named below.
The apps ship this folder as it is. Android's `:gym` module carries it in its assets under
`gym-coach/`, the web's `src/products/gym/coach/words.js` imports it; the iPhone does not
carry it yet. The backend embeds the same files at build time, so the server's Coach speaks these words too.

| File | What it holds |
|---|---|
| `prompt.md` | The system prompt of a turn, byte for byte. |
| `first-content.json` | The words of the turn's first content: `contextLeads`, the sentence that leads each context read, keyed by ability name; `earlierConversation`, the line that marks the earlier conversation and the name each speaker goes by in it; `pictureOnlyQuestion`, the question that stands for a picture sent with none. |
| `refusals.json` | The sentence the model reads beside each refusal code of the gate. |

## How the first content is put together

One user message, in this order:

1. When the conversation has history, one text block: `earlierConversation.marker`, then for each
   line, oldest first, `"\n\n"`, the speaker's name (`lifter` or `coach`), `": "` and the line's text.
2. For each context read, one text block: its lead, `"\n"`, and the read's result in canonical form.
3. The pictures.
4. The question as one text block, or `pictureOnlyQuestion` when the question is blank.

## How a refusal reads

The model reads a refused call as an error result `[<code>] <ability>: <sentence>`. In `one-proposal`,
`{target}` is the kind of proposal already written: `routine` or `workout`. `invalid-input` has no
sentence here: its sentence is the schema violation the check found.
