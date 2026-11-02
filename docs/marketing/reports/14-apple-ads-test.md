# 14 · Conditional exact-match Apple Ads

Kind: experiment, gated · Stage: 1 · Window: from Feb 20, 2027, after creator day-35 results; decide by Apr 15, 2027 · Cash: $300 to $500 · CEO hours / agent days: 1h / 1d

## Idea

Three to five exact-match search terms of the "workout log" and "workout tracker" class, each
pointed at a matching custom product page, run as a single small test after the creator campaign
has produced a baseline. The bid ceiling is derived, not guessed: allowable subscriber CAC
multiplied by measured install-to-paid. The test exists to read intent-driven conversion against
the creator baseline, not to buy installs.

## Pros

- Controllable, high-intent traffic with clean attribution.
- The cheapest paid channel on record for this category.
- Custom product pages lower CPA and lift tap-to-install.
- A small test answers whether paid search ever belongs in Stage 2.

## Cons

- Likely uneconomic: category CPI against freemium conversion implies $105 to $180 per subscriber.
- Under 50 optimisation events per ad set per week the read is void.
- Cheap installs look like success and are not.
- Q1 bids are seasonal; replication is needed before any scale.

## Estimates

| Item | Number | Basis |
|---|---|---|
| Cash | $300 to $500 | cap |
| Installs | about 80 to 130 | assumption from AppTweak's $3.77 US Health & Fitness CPI, 2025 data |
| Buyers | 2 to 4 at 2% to 3% paid | assumption |
| Apple Ads CPA, all categories | $2.51 | MobileAction 2026, 2025 data |
| CPA on custom product pages | $3.07 in 2025, down from $4.58 in 2024 | MobileAction 2026 |
| Readability | 50 optimisation events per ad set per week | Meta learning-phase rule, applied here |

## Success metric

Fully loaded CAC at or below C90 after maturation, confirmed later by renewals.

## Failure metric

Projected CAC above 2 × the limit after 100 day-35-mature installs, or the budget exhausted first.
Decide by Apr 15, 2027. On failure, paid search is closed until install-to-paid on exact-match
terms is three to four times the category median. Do not spend to complete the plan.

## Justification

Paid search is the one paid channel whose arithmetic can be checked in advance, and the arithmetic
says it fails at median conversion: $3.77 per install at 2.9% install-to-paid is about $130 per
subscriber against roughly $24 of year-one revenue per payer (RevenueCat 2026). It stays in the
plan because exact-match terms with a matching product page may convert far above the median, and
the only way to know is a bounded test read against the creator baseline. Meta and TikTok were
rejected as test channels because a readable test there costs $500 or more a week per ad set.

## Dependencies

- Report 09's day-35 results, so there is a baseline to beat.
- Report 05's custom product pages, one per theme.
- Report 02's measured install-to-paid, which sets the bid ceiling.

## Decision log

| Date | Decision | Numbers |
|---|---|---|
