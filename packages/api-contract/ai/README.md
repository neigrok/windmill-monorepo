# AI service contracts

The [AI service specification](../../../docs/foundation/ai-service.md) defines the public and internal
doors. This package supplies executable examples for issuers and callers.

- `passes/vectors.json` pins exact payload bytes, development Ed25519 keys, signatures and pass
  refusals. The published test key cannot open a production service.
- `wire/fixtures.json` covers allowances, public refusals, text requests and events, live controls and
  events, call states, grants, corrections and operator inspection.
- `wire/generate.py` writes deterministic wire examples. `check.py` independently checks their fields,
  states, integer counts, exact money, pagination and scenario coverage. Its negative probes must
  reject malformed examples.

Money is an exact, nonnegative USD string with at most nine fractional digits. Call IDs are opaque
caller identifiers; internal service IDs and pagination cursors are positive integers. Lists descend
by service ID. `nextBeforeId` is the last returned ID when another page exists, and null otherwise.
The compact page fixtures show the two cursor states; the server's HTTP tests exercise the actual
1,000-row boundary and compare every returned field.

`textTerminals` and `liveTerminals` name the outcomes a caller handles. `liveFirstFailures` are
refusals before a session dispatches, with null `charged`. `prestreamRefusals` cover the counting
provider's rejection or unavailability before a text stream starts. An allowance may be null when
accounting is unavailable. A terminal event's `charged` may be null while settlement retries.

An assistant's `carry` is opaque. Server tests check its versioned base64url envelope and replace its
random ciphertext with `wm-carry.v1.<opaque>` before comparing the complete event. They preserve and
compare every other field. Provider tests cover the seal's authentication and continuation behavior.

Run the deterministic checks from the repository root:

```sh
python3 packages/api-contract/ai/passes/generate.py --check
python3 packages/api-contract/ai/wire/generate.py --check
python3 packages/api-contract/ai/check.py --self-test
```

`services/ai/crates/server/tests/wire.rs` also asserts actual serializers, request parsers, HTTP routes
and WebSocket messages against these examples. Its database cases require `AI_TEST_DATABASE_URL` and
create and remove isolated databases. CI requires that variable. All provider traffic in those tests
stays on loopback; no provider key or paid call is used.
