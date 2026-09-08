# Active AI allowance verification

The customer allowance counts active requests. Automatic Echo segmentation and curation remain in operational reporting, use their own background ceiling, and do not debit the customer allowance. Full Echo passages are available without One; the web has no Echo subscription sheet or disable control.

The account proposal uses active AI credits without a separate roadmap request-count card. The roadmap interaction proposal has request, review and applied-result screens; its preview/apply protocol is not implemented. Legacy API and source identifiers remain compatibility details, while customer-facing copy uses AI assistance and Ask AI.

## Checks

- Focused backend suite: 116/116 passed, zero skips or stopped cases, including real PostgreSQL operation-filter tests and Echo API/derivation tests. The server target rebuilt successfully.
- Web: 1,664 tests passed, followed by the production bundle and static landing-shell build.
- iOS: simulator build succeeded after the account-copy update.
- Local stack: isolated backend on 8089 and Vite on 5174. A disposable account with subscription `active: false` received the complete 15-word Echo, `entitled: true`, and `withheldWords: 0`. In the browser, opening that Echo navigated to the original passage without an upgrade flow. Test history met the existing presentation floor.
- Figma: revised account screens and the three roadmap proposal screens rendered and visually inspected. Related Marketing, Roadmap and Journal specimens were reconciled; this was a bounded canon review, not an audit of every historical frame.
- The exact staged snapshot built every backend target in an isolated directory. Its full suite passed 2,133/2,133 cases with PostgreSQL enabled, zero skips or failures, against a separate database using the staged schema. The disposable database, browser account and verification servers were cleaned up.

## Structural observations

Chargeability and operational spend are separate concerns. The repository takes an explicit include/exclude operation filter, while the composition root supplies passive operation names so platform code stays product-neutral. Existing ledger rows use the same rule without a migration.

Removing the Echo paywall also removes its truncation helper, component, state and styles. User-facing credit balances still require an authenticated usage API and supported transcription pricing. Anonymous roadmap import still needs an attribution decision before becoming an account debit. These follow-ups are recorded in `account-usage-contract`; the new roadmap interaction is tracked in `roadmap-ai-redesign`.
