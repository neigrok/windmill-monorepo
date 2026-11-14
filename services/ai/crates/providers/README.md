# AI providers

This crate owns Anthropic text and OpenAI/Azure live transcription transports. It has no storage,
account identity, allowance policy or money arithmetic. Constructor arguments supply provider
addresses, credentials, the carry key and model profiles. Only loopback fixture servers are used by
the tests; no test reads a live key or sends a billable request.

`TextRequest::parse` validates the public text shape. `Anthropic::prepare` consumes it and creates the
provider request. `count` returns a **raw** input count; the domain adds the percentage and fixed
margin. Its two-second deadline covers the entire response. An unavailable counting door falls
back to serialized request bytes, the profile's image ceiling for each image, and its tool overhead.
An explicit malformed-request rejection or key/account refusal is returned to the server.

`run` consumes a prepared request and the admitted output cap. Its synchronous callback must append
events to the server's bounded in-memory result store without waiting for a caller. No internal
queue buffers events. A reader disappearing does not cancel the task that owns `run`. Malformed or
oversized output switches to discard mode until EOF or the 600-second deadline. A completed stream
with missing usage returns `usage: None`; a completed stream with an unknown stop retains its usage
and returns a static failure. Broken streams never return billable usage. These distinctions let the
server choose settlement or the full-reservation assumption.

Carry encrypts the complete assistant blocks, including reasoning and provider signatures, with
XChaCha20-Poly1305 and a fresh 192-bit nonce. A carry whose authentication fails rebuilds the assistant from visible parts.
Content and credentials implement neither `Debug` nor `Display`. Error formatting contains only
static codes, certainty and HTTP status, never provider text or request IDs.

Requests are bounded at 8 MiB and eight images, each SSE frame at 1 MiB, and the accumulated provider
response at 16 MiB. HTTP redirects, retry policy and environmental proxies are disabled. A connect
failure is unconsumed; a send failure whose delivery cannot be excluded is assumed. Explicit HTTP
error statuses before stream events are unconsumed.

`LiveClient` uses one configured OpenAI or Azure endpoint. `LiveSession` exposes audio append,
commit, keywords, receive and close; it supplies provider item IDs without reordering. The server
owns turn order, time limits, slices, audio byte accounting and final transcript assembly. A failed
audio send may have delivered bytes, so the server must account for that attempted frame. Audio is
24 kHz mono PCM16; frames are at most 64 KiB. Session opening, including configuration acknowledgement,
is bounded at ten seconds. The adapter sends neither language hints nor end-user identifiers.

The wire shapes are based on the official [Anthropic stream](https://platform.claude.com/docs/en/build-with-claude/streaming),
[token count](https://platform.claude.com/docs/en/api/messages/count_tokens),
[cache usage](https://platform.claude.com/docs/en/build-with-claude/prompt-caching),
[OpenAI live transcription](https://developers.openai.com/api/docs/guides/realtime-transcription), and
[Azure Realtime](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-websockets)
references. Model image ceilings and tool overhead belong in the injected profiles, with values
from [vision](https://platform.claude.com/docs/en/build-with-claude/vision) and
[tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview).
