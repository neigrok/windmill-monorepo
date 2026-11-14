# App Store test payloads

Descriptions of App Store payloads for `app_store_test_signer` to sign under the
[test chain](../test-chain/README.md). Each describes one moment in the life of one Windmill One
subscription: original transaction `2000000000000001`, product `works.windmill.app.one.monthly` at
US$12.00, bought with the account hint `6f9d0c2e-4b1a-4c8e-9f3d-2a7b5e1c0d84`. Its dates count from
the moment it is signed, so a description signed today states today's dates.

| File | Payload | `status` | The moment |
|---|---|---|---|
| `started.json` | `SUBSCRIBED` `INITIAL_BUY` | 1 | The first purchase, carrying the account hint; its period ends in 30 days |
| `purchase-transaction.json` | a transaction | | The same purchase's transaction on its own, as the phone posts it to the claim door |
| `renewed.json` | `DID_RENEW` | 1 | The second period, transaction `2000000000000002`, charged now |
| `renewal-turned-off.json` | `DID_CHANGE_RENEWAL_STATUS` `AUTO_RENEW_DISABLED` | 1 | The customer turns renewal off 10 days into the second period |
| `payment-failed-into-grace.json` | `DID_FAIL_TO_RENEW` `GRACE_PERIOD` | 4 | The renewal charge fails as the second period ends; access holds through the 16-day grace (R-7) |
| `expired.json` | `EXPIRED` `VOLUNTARY` | 2 | The second period ends with renewal off |
| `refunded.json` | `REFUND` | 5 | Apple refunds the second period 10 days in |
| `refund-reversed.json` | `REFUND_REVERSED` | 1 | Apple reverses that refund |

The fields are those of Apple's App Store Server Notifications V2 payloads. Which of them Apple states
at each moment, and with which values, is not confirmed against the sandbox; that is
m3-verify-sandbox-lifecycle.

A run that needs the hint to name a real account rewrites it before signing:

```sh
jq --arg account "$ACCOUNT_ID" \
  '.notification.data |= (.signedTransactionInfo.appAccountToken = $account | .signedRenewalInfo.appAccountToken = $account)' \
  tests/fixtures/app_store/test-payloads/started.json | cargo run -q -p app_store_test_signer
```
