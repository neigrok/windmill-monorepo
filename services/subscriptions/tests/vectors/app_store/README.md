# App Store decoding vectors

Each file is one App Store notification, one transaction a phone hands to the claim door, or one status
the App Store Server API answers a pull with, and what `app_store::decoding` must make of it. The Rust harness is
[`crates/app_store/tests/decoding.rs`](../../../crates/app_store/tests/decoding.rs); the mapping they
pin is in [ARCHITECTURE.md](../../../ARCHITECTURE.md#app-store-decoding).

A file is `{note, notification, expect}`, `{note, claim, expect}` or `{note, status, expect}`.

| Key | Holds |
|---|---|
| `note` | What the vector shows. |
| `notification` | The notification as `SignedDataVerifier` hands it over, every key present: `notificationType`, `subtype`, `signedDate`, `environment`, `status`, and `transaction` and `renewalInfo`, the decoded JWSTransactionDecodedPayload and JWSRenewalInfoDecodedPayload in Apple's own field names, or `null`. |
| `claim` | A decoded JWSTransactionDecodedPayload. |
| `status` | A pulled status as `SignedDataVerifier::verify_status` hands it over, every key present: `environment`, `status`, and `transaction` and `renewalInfo` in Apple's own field names, or `null`. |
| `expect` | One outcome, written in full: `{observation, accountToken}`, the observation in the grammar of the [domain's vectors](../README.md) with its status flat; `{awaitsStatus, awaiting}`, a statement whose state must be pulled, as `{lineage, observedAt, ownership, period, accountToken, cancelRequestedAt}`, and why, `earlier_transaction` or `latest_unconfirmed`; `{periodStatement}` for a claim, in the same shape; `{silent: code}`; or `{unsupported: code}`. A status
expects an observation, `{awaitsStatus, awaiting}` or `{unsupported: code}`. |

Apple's payloads count epoch milliseconds and state prices in milliunits, as Apple sends them; the
expectations write instants as UTC ISO 8601. Store ids are invented: the lineage of most vectors is
`2000000100000001`, whose first month runs from 2027-01-01T10:00:00Z and second from
2027-02-01T10:00:00Z.
