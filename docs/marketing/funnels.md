# Marketing scorecard

**Did a new person use Windmill again when the same need came back?** Give each pilot a start date, source, entry surface, fixed denominator and observation window before the first invitation. The founder owns the weekly decision. Engineering supplies aggregate counts and verifies each route. Use the existing private bet record for results.

## What to count

| Funnel | Unit and denominator | Numerator and clock | Available evidence |
|---|---|---|---|
| Recruitment | Qualified people personally invited, then those who opt in, then those who try. Deduplicate within a pilot. | Count each stage. Mark an inaccessible build or a declined invitation as such. | Private founder tally. Record host placements separately when audience size is unknown. |
| Roadmap activation | Freeze the first 20 distinct new builders who personally try **Ship v1**, including signed-out attempts. | Count a person once when they own their copy of the starter with at least three present nodes and complete a node on it within 48 hours of tree creation. | Account-backed definition in `funnel_activation`. Report signed-out local successes and unverified attempts in their own columns. |
| Roadmap return | All 20 starters. Report how many account windows have closed beside the fixed denominator. | Verified return to the participant’s Roadmap from day 7 inclusive to day 14 exclusive after signup. A guest-only return can be observed separately. It cannot qualify for the 4/20 account gate. | `funnel_returns` reports **all eligible accounts with any activity**. A cohort-specific, product-specific return needs a scoped read or an opt-in observation. Do not relabel the sitewide rate. |
| Gym activation | First 10 qualified native testers who enroll, including installation failures and people who log no sets. | Two distinct finished workouts, each with at least five logged sets, within seven days of the first set. Count a person once. Keep someone who never logs a first set in the denominator at pilot close. | Use an agreed pilot start cutoff and opt-in check-in on the phone until a verified cohort view exists. Record the two qualifying sessions as a count, with no workout content. |
| Search acquisition | Per engine and canonical page, count submitted, indexed, impressions and clicks. | For credited visits, count a first useful action and repeat only where there is a verified source-to-action link. | Search Console and Bing Webmaster Tools for provider data. Client events can undercount. Report unknown attribution as unknown. [Inspection runbook](reports/06-brand-search-identity.md) |
| External assistant | Voluntary participants trying a named client, or verified product-scoped connections when a cohort measure exists. | Connection → successful first useful tool result → result opened or acted on → use on a later day. An OAuth grant or a tool-list call alone is setup. | Observe synthetic setup separately. Record the actual user result through consented observation or bounded event labels. [Agent brief](reports/12-directories-and-show-hn.md) |

A locally successful action can teach us about usability even when it cannot be credited to the account-backed activation gate. Show the observed, self-reported and unknown counts. If enough outcomes are missing to change the decision, hold the decision and improve observation before repeating the test. An immature cohort is pending. Avoid forcing sign-in to improve measurement.

## A Monday review that takes 30 minutes

1. **Five minutes on access.** Can a stranger open the link and start? Did the right canonical get indexed? Record each engine's last inspection date and reason for an exclusion. Search impressions, AI citations and a human click have different meanings.
2. **Ten minutes on people.** For each source fill in the row below. Use distinct people for pilot gates. Read counts before percentages, separate assisted and unaided outcomes, and note the last date on which each cohort can mature.
3. **Ten minutes on the largest loss.** Review two opt-in observations from that step. Choose one change to the invitation, first task, distribution source or product. Technical failures go to the owning team with their static operation and outcome.
4. **Five minutes on the decision.** Apply the continue, repeat or rework rules in the [90-day plan](strategy.md). Write the result on the dogfood node with its denominator, dates, evidence type, founder hours and next owner. If both pass, compare returning people per founder hour within each channel and repeat with an independent group.

| Cohort / dates | Source / surface | Invited / opted in / tried | Activated / fixed cohort | Returned / fixed cohort | Unknown / still maturing | Founder hours / cash | Decision / owner / next read |
|---|---|---|---|---|---|---|---|
| Ship v1 · batch 1 | Fill at recruitment | Pending | Pending / 20 target | Pending | Pending | Record actuals | Founder · 14 days after final eligible signup |
| Repeat routine · batch 1 | Fill at recruitment | Pending | Pending / 10 target | Second qualifying workout is the activation | Pending | Record actuals | Founder · seven days after Nov 25 first-set cutoff |

For comparison, engineering can run the aggregate weekly queries in the [database funnel guide](../../backend/db/FUNNEL.md). `trees.forked_from` records a real fork. A share click, copy or fork attempt is intent. Sitewide weekly counts include other traffic. No source-to-payer join is assumed.

## Later funnels

- **Gym Coach and paid demand.** Eligible tester → useful hosted Coach result → later-week use → genuine purchase → first renewal → realised 90-day contribution. Measure actual costs including retries. Keep the free manual log, external MCP work and owner-funded access distinct from a customer paying.
- **Journal.** First saved page → writes on two distinct local dates within seven days of the first save → finds a past entry. Count only the occurrence and success of retrieval. Talk is unavailable under the enabled audio policy. [Usage contract](../AI_USAGE_REVIEW.md)
- **Attribution.** Start with a bounded source such as community host, direct invite, organic search, assistant referral, directory or unknown. When campaign joins become available, test the same voluntary landing-to-action path with a synthetic account. Never reconstruct identity from device fingerprinting, raw referrers, private URLs or account emails.
- **Telemetry.** New product events use the first-party `POST /v1/events` intake and bounded approved labels. Boundary failures go to Sentry under static operation names. Search Console exports may contain search terms. Keep exports private, publish only aggregate totals, and exclude user prompts, journal text, workout details, account IDs and tokens from marketing reporting.
