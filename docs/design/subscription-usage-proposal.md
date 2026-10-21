# Account plan and USD AI allowance — design proposal

Status: customer UI proposal. The backend USD contract is enabled in production; its configuration default is off.
The drawings require the lifetime/free/funded policy and provider capacity states below.

## Drawings

The shared shell owns this surface. The drawings are in the **2026-10 · Account · Usage · Proposal** section on the Proposals page in Windmill · Shell.

| View | Figma |
| --- | --- |
| Desktop overview | [Plan and usage](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=2-9372) |
| Mobile web overview | [Plan and usage](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=2-9405) |
| Prelaunch supported-data example | [Prelaunch](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=2-9429) |
| Mobile web detail | [AI details](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=2-9445) |
| Future subscription management | [Manage plan](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=2-9469) |

## USD and allowance periods

USD means model-cost allowance, not prepaid cash, a subscription invoice or a number of questions.
Amounts come from the server; small charges may use fractional cents. Held reservations reduce
available capacity and require a pending state. A reservation estimates the current request's
input cost and includes its output cap; actual usage can be lower or higher. It is not a promised
final price or hard spending ceiling.

| Tier | Allowance | Display period |
| --- | --- | --- |
| Anonymous | $0.05 per installation credential | Lifetime; no reset date |
| Verified logged-in | $0.25, including associated anonymous spending from the current month | UTC calendar month |
| Windmill One | $7 per funded period | Actual subscription billing period; owner grants use UTC calendar months |

Owner access is a funding source within One and is labeled separately from subscription funding.
Account capacity is shared across
products and devices. Signing in permanently binds the anonymous installation to the account;
it does not grant a fresh anonymous allowance. Current-month anonymous cost counts toward the
free account allowance. A current subscription grant takes priority over an owner calendar grant;
the display never combines their remaining amounts. An expired subscription must not hide an
available owner grant.

**All hosted AI work consumes the individual allowance**, including automatic Journal Echoes.
Show that treatment plainly. Complete existing Echo passages remain readable; do not use cropped
passages or withheld words as an upgrade prompt. When capacity is unavailable, new background AI
work waits. No passive-feature switch or separate roadmap request-count meter is introduced here.

Free access also depends on shared $100 monthly and $5 daily pools. Paid funded capacity is
isolated from those pools. These are internal operational amounts; the customer UI displays the
bounded availability reason and applicable reset, without exposing pool totals. A daily free-pool
pause must not imply that the individual monthly allowance has been spent. One free or two paid
in-flight requests can temporarily block another request.

## Supported and unavailable states

The [backend contract](../../backend/AI_ALLOWANCES.md) defines exact USD strings, individual
`resetsAtMs`, constrained-budget `budgetResetsAtMs` and lifetime null reset. A funded period can
cross a calendar boundary; it must not be drawn as resetting on the first of the month. Period end
is not a promise of a future paid grant. Uncertain calls can retain capacity after a boundary.

A positive remaining balance can still be too small for a request's reservation. Draw this as a
request-capacity refusal rather than zero balance. Do not claim a shorter prompt will necessarily
fit: the model, history, tools, images and configured output cap also affect the reservation.
Anonymous access is limited to Gym onboarding through a server-issued installation credential,
IP limits and shared budgets. Installation resets are not guaranteed to preserve identity.
Loading and failed reads show an unavailable state; they never flash Free, zero or empty history.

Checkout is closed. The page offers no purchase, top-up, overage, fabricated renewal or
self-service cancellation action. Future billing management needs verified access source, renewal
date, amount/currency, scheduled action and hosted management destination. Example price/payment
figures in Figma are illustrative and cannot be presented as live facts.

## Interaction and accessibility

Overview opens detail and plan management; Back/Done returns to the originating screen. Keep drafts
and completed work when a request is refused. Retry requires an explicit user action and server
admission; a recovered balance never sends a draft automatically.

Use shared button, focus and reduced-motion behavior. Remaining USD and its period form one screen
reader announcement. Do not animate urgency, countdowns or ambient meter pulses. Mobile web uses
one column and separate detail destinations, with at least 44px targets and stable back navigation.
These mobile-web drawings do not claim native iOS or Android components.

## Implementation dependencies

Account usage screens need the USD and refusal contract; anonymous onboarding uses its installation
read and binding endpoints. Other anonymous products need their own integration; voice
needs supported audio accounting. Estimated reservations must be distinguished from actual use
and unresolved holds. The 50/80/95% owner-email alerts are operational controls, not customer sales
notifications. Design drift is tracked in [consistency](consistency.md), and account work remains
linked to the dogfood account-usage-contract and subscription-allowance-design nodes.
