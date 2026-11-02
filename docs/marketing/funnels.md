# Funnels and instrumentation

The paths from first touch to a renewing Windmill One payer, what each step must emit, and the
thresholds that decide a gate. Benchmarks are in [benchmarks.md](benchmarks.md); the stage gates
they feed are in [strategy.md](strategy.md).

## The paid behaviour per product

Only Windmill-funded AI is paid. Everything a person does by hand is free, signed out included.

| Product | What One pays for | What is free and never a paid signal |
|---|---|---|
| Gym | Coach turns: screenshot or conversation to a routine, proposals the lifter applies | the log, routines, prefill, sharing a session |
| Roadmap | Tend requests (30 a month free, 300 on One) | editing, publishing, forking, and every tree an external agent builds through MCP on its own model budget |
| Journal | Voice transcription (requires One, consumes the allowance) | writing, search, Echoes (an internal passive budget, never the allowance) |

A fork, a public tree built by Claude through MCP, or an Echo is discovery and retention evidence.
None of them counts toward paid demand.

## Funnels

Each funnel is a learning path, not a gate a person must pass. People may buy earlier.

### Gym (the paid wedge)

```
source → store page or landing → install or open web → first set logged (signed out is fine)
→ verified account (asked only when the person starts Coach past the installation allowance)
→ first Coach task (screenshot or talk) → proposal applied → workout finished
→ activation: two sessions of at least five sets within 7 days of the first set
→ a later Coach task in a different week → One purchase → first renewal → day 90 still paying
```

### Roadmap (discovery, and Tend as its paid trigger)

```
public tree, share unfurl, gallery, directory listing or Show HN → visit → fork or birth
→ first completion within 48 hours (activation: a tree with three or more nodes and one completion)
→ return within 7 days → a Tend request on the free allowance → further Tend requests in another week
→ One purchase → first renewal
```

### Journal (retention and featuring material; Voice as its paid trigger)

```
recommendation, featuring or landing → first saved page → writing on three separate days in week one
→ an Echo opened → Voice attempted (asks for One) → One purchase → Voice used again in another week
→ first renewal
```

### Superapp (second-order, tested only after Stage 1)

```
first-product activation → one invitation to a second product (randomised against no invitation)
→ second-product activation → shared allowance used in both → One purchase or retained One
```

## What every step emits

Events go through the first-party `POST /v1/events` intake with allowlisted, bounded labels.
Failures at boundaries go to Sentry without content. Never a journal passage, a workout or movement
name, a Coach question or answer, a screenshot, a prompt, a model response, an email or a token.

| Layer | Fields and events |
|---|---|
| Attribution | source, campaign, creative, creator id, custom product page id, product entry, platform, country. Carried from the store page or landing through voluntary account creation by link parameters and server-side session, never by fingerprinting |
| Store | product page view, install (App Store Connect and Play Console reports joined weekly by campaign id) |
| Activation | first set, first page, first node; the activation event per product above; time to first useful result |
| AI | request, completion, failure, refusal code (`out-of-allowance`, pool exhausted, unentitled), model, estimated and settled USD cost, proposal shown, applied, rejected; onboarding model vs bound-seat model kept apart |
| Funding | which allowance paid: anonymous installation, verified monthly, welcome grant, One grant, passive Echo budget. External MCP calls carry no cost and are labelled external |
| Money | plan viewed, checkout opened, purchase, restore, cancellation, refund, renewal, store fee, tax, payment-processor fee, recorded server-side from the Paddle and store mirrors |
| Retention | D1, D7, D30 return per product; Coach, Tend or Voice use across separate weeks; first renewal; day-90 paid retention |
| Loops | share card rendered, share completed, referred visit, referred install, referred activation, referred purchase; fork, fork claim, returning fork owner |
| Lifecycle | recap email sent, delivered, opened, clicked, unsubscribed; push permission asked, granted; prompted-for-rating moment |

The analyst views in `backend/db/funnel.sql` cover Roadmap signups, activation, shares, returns and
landings. Gym and Journal activation, the AI cost ledger, the money mirror and the attribution join
are not in those views yet; adding them is report 02.

## Thresholds

Benchmarks set the floor; a Windmill number below the floor is a problem, a number above it is not
yet a win. Cohort counts are always reported beside rates.

| Step | Floor | Where it comes from |
|---|---|---|
| Store page conversion | 8.5% iOS, 16% Android | AppTweak 2025 category averages |
| Install to first logged set or saved page | 60% | account-optional onboarding completion range |
| D1 / D7 / D30 return | 25% / 12% / 7% | Health & Fitness and Productivity medians |
| Gym activation (two sessions of five sets in 7 days) | 20% of installs | internal target, no public benchmark |
| Install to paid at day 35 (freemium) | 2% floor, 2.9% Health & Fitness median, 6.2% top quartile | RevenueCat 2026 |
| Repeat paid-AI use in a later week | 50% of buyers | internal target set in the negotiation |
| First renewal | 70% | Stage 2 gate; AI-app monthly retention is weaker, so this is deliberately high |
| Refunds | under 4.7% | Health & Fitness median |
| Free-pool refusals | under 1% of otherwise-eligible AI requests per day | Stage 0 gate |
| Ad set readability | 50 optimisation events per ad set per week | Meta learning-phase rule, applied to every paid channel |

## The weekly review

Thirty minutes, every Monday, six numbers from the funnel views, written into the relevant report
the same day a gate is decided:

1. Installs by source, with store page conversion.
2. Activation per product, as count and rate over the week's cohort.
3. Coach, Tend and Voice tasks with their settled USD cost, mean and P90 per account.
4. Free-pool refusals and the reserve left for the month.
5. New payers, refunds and unique non-refunded payers to date.
6. First renewals due and kept.

Ten buyers give direction, not certainty. A number between the pass and fail lines is
inconclusive and does not unlock the next stage.
