# Account plan and AI credits — design proposal

Status: proposal, with illustrative account data. No application behavior changes.

## Drawings

The shared shell owns this surface. The drawings are on the **Account · Usage · Proposal** page in Windmill · Design System.

| View | Figma |
|---|---|
| Desktop overview | [Plan and usage](https://www.figma.com/design/qoOwNbWOYE1GFi0yR5uGY2?node-id=89-303) |
| Mobile web overview | [Plan and usage](https://www.figma.com/design/qoOwNbWOYE1GFi0yR5uGY2?node-id=89-304) |
| Prelaunch supported-data example | [Prelaunch](https://www.figma.com/design/qoOwNbWOYE1GFi0yR5uGY2?node-id=89-305) |
| Mobile web detail | [AI details](https://www.figma.com/design/qoOwNbWOYE1GFi0yR5uGY2?node-id=89-306) |
| Future subscription management | [Manage plan](https://www.figma.com/design/qoOwNbWOYE1GFi0yR5uGY2?node-id=91-35) |

## Relative unit

The user-facing unit is **AI credits**. Raw model tokens stay out of the customer interface. Credits are a fixed denomination of cost-weighted AI work, identical across plans; an action may debit a fraction of a credit. A credit never means one request.

For these examples, one credit equals 0.5% of the base allowance: 200 credits at the base and 400 on One. This is an illustrative conversion of the current 2:1 internal allowance ratio, not an approved commercial grant. The One specimen reconciles exactly: 272 remaining + 72 roadmap + 40 gym + 16 journal = 400. Changing plans must not change the value of an existing credit. Billing dollars and provider cost ceilings must never be presented as the same thing.

The service must aggregate exact debits before rounding display values. Keep fractional precision for small charges and disclose rounding in activity details. Avoid rounding every small call up to a whole credit. A production denomination and plan amounts remain a product decision.

## Active requests only

Only AI work explicitly requested by the user debits customer credits: roadmap AI requests, gym Coach and journal voice. The specimen's journal activity is voice only. Automatic echoes are included, show complete passages for everyone, cannot be disabled, and never debit the customer allowance. Internal provider cost accounting may still record passive processing without exposing it as a customer charge.

There is one shared credit allowance across products. No separate roadmap run-count meter or calendar-month AI quota belongs in this proposal. Credits return as counted activity becomes older than 30 days; subscription payment dates are separate. A preflight balance never guarantees a fixed number of future actions.

## Supported state and proposed controls

The factual audit is [AI usage review](../AI_USAGE_REVIEW.md). The customer credit balance, product breakdown and fractional receipts require the proposed account usage contract. Anonymous roadmap compose work must not appear as an account debit.

Paid checkout is closed. The prelaunch view therefore shows no checkout, renewal promise or self-service cancellation. It shows an explicit unavailable credit-reporting state, never a zero balance. This is a new design proposal, not a screenshot of the existing app.

Future subscription management requires a customer billing contract: access source, real renewal date, amount and currency, scheduled action kind, hosted billing destination and cancellation. The drawn $12/month and 1 Oct payment are labeled example data. Owner-granted One access needs its own non-renewing access state; subscription status alone must never decide entitlement. Current cancellation remains email support under the pricing canon.

No top-ups, overages or upgrade pressure are introduced. The account page contains no passive-feature switch. [Roadmap AI redesign](roadmap/ai-assistance-redesign.md) specifies the active request, preview and apply flow.

## Interaction and accessibility

Overview navigation opens details and plan management; Back/Done returns to the originating screen in the Figma prototype. Billing details and cancellation are drawn controls with behavior specified here; they are not executable billing or server integrations.

Cancellation must open a neutral confirmation naming the verified end date, retaining stored work, and offering equally legible Keep plan and Cancel plan controls. Show the scheduled result only after server confirmation. Failed requests keep the current state with a retry affordance. A generic scheduled change must never be relabeled as cancellation.

For fetch failures, show Usage unavailable and Retry. Loading must not flash Free, zero credits or an empty history. Paid access, owner grants, scheduled changes and credit state load independently.

Use the shared button hover and 0.97 press treatment; transition state colors in 150–280ms. Credit bars change only after confirmed data, with a short ease-out update; reduced motion uses the final value directly. No ambient meter pulse or animated countdown.

Mobile web remains one column; detail and management are separate destinations. Cancellation and confirmation actions belong in a pinned bottom action area above the safe inset. Screen readers announce a single remaining-credit value and the window, not every bar segment. Buttons need at least 44px hit areas, keyboard focus and stable back navigation. No custom native iOS or Android components are claimed by these mobile-web drawings.

## Structure and verification

The page reuses the existing semantic theme, spacing and radius variables, Baloo 2 / Nunito / JetBrains Mono styles, and Button instances. Account / Usage row is one local component with editable Title, Detail and Value properties. Desktop groups allowance and activity in two columns; mobile uses the same hierarchy in one column.

The design simplification pass consolidates repeated feature rows, removes passive-feature controls and separate request-count meters, and keeps raw token details out of the UI. New controls remain on the isolated proposal page; the published foundations are unchanged.

Implementation follow-up: account usage contract, metering correctness and subscription management must land before the future example can become a live account page. The dogfood task is account-usage-contract, connected to subscription-allowance-design.

Verification is performed on the revised frames after the active-request policy update.

The four changed account views were rendered and visually inspected after revision; the management sheet remains as verified in the preceding pass. The account proposal page has no obsolete request-unit wording or automatic-echo controls. The activity fixture still reconciles to 128 used and 272 remaining, with Journal representing voice only. The simplification removes an entire settings control and separate quota card rather than compensating with explanatory warnings.
