# Windmill Pricing — pay for the AI's work, not for the product

The canonical spec for the paid layer.

> **Principle: sell the new power, never re-sell a default.** The product is free forever.
> What costs money is the AI doing the work: **tending** in the roadmap, **Talk** and **full
> echoes** in the journal. Gym sells nothing. **Windmill One is one flat plan — $12/month for
> 300 tendings a month.** One plan, one price, no tiers.

**Nothing is on sale.** `paidPlansOpen()` in `web/src/shell/billing/checkout.js` returns a
hardcoded `false`, and `BillingApi::startCheckout` 503s with no Paddle price id configured, so
no surface offers a checkout and none can complete. Windmill One is held only by an account the
owner list names; the gated features stay shut for everyone else, and the pricing page says so
on its own plan card.

Shippable pages: `web/public/pricing.html` + `web/public/refunds.html`, light only. The
in-app meter and the out-of-allowance pause are specified in
`../../roadmap/guidelines/tending.md` §6 and the settings usage row. Settings carries **no
Plan section** while nothing can be bought — naming a tier nobody can buy is an advertisement,
not a setting.

---

## 1. What's free

Everything except the AI doing the work: unlimited trees and steps, **unlimited hand
editing**, **private by default**, share and fork, all nine quests, export, every device, the
MCP server and an API key. The whole journal canvas and its on-device search. The whole gym —
its log, its connected log over MCP, and Ask. Plus **30 tendings every month, free**.

There is **no usage meter on the product itself**.

**Tending needs an account, and it is the only thing that does.** The allowance is metered
per account; there is **no anonymous tending**. Everything else works signed out, forever.
Tending is an *account verb* in `auth.md`'s sense — the door opens at the moment it is asked
for and resumes after — never a wall, and never a reason to ask for an account on launch.

## 2. What's metered: tendings

- **A tending = one instruction to the AI** — "plant a 10k plan", "add a testing branch", "is
  this realistic?". One sentence, one tending, **one receipt** in the ledger. It maps exactly
  to `tending.md`'s "one sentence = one history step".
- **Hand editing is unlimited and never counted.**
- **Every tending is a visible receipt.** The meter is transparent, not a mystery counter.
- An allowance, never literal "unlimited" — every tending bills tokens per run.

## 3. The plan

**Windmill One — $12/month — 300 tendings a month** (about ten a day), plus Talk and full
echoes in the journal. USD, before tax. One plan; no tier ladder, no add-on packs, no per-run
pricing to forecast.

**Free stays at 30 tendings/month**; Windmill One raises it to 300. Both reset monthly. Talk
and echoes ride this same subscription — never a new tier.

## 4. The honesty beats

1. **One price, one plan.** "That's the whole plan."
2. **Nothing is deleted if you stop.** Drop to Free and your trees are untouched; hand editing
   is always free. Running out pauses the robot, never the product — the `tending.md` §6.4
   refusal face.
3. **You can't overspend it.** When the month's tendings are gone, tending pauses until the
   month turns — no overage, no per-run bill.

**Colour rule:** terracotta = the buy verb + tending surface; brand-soft = the Windmill One
card; **gold** = "running low" nudge only; **brick = never** (reserved for deletion, X6).
Register: never scare, never gate (`../../roadmap/guidelines/honesty.md`).

## 5. Non-negotiables

- The **30-day money-back guarantee** on the subscription, visible where money is asked.
- **Refunds / Terms / Privacy** reachable from navigation, in the shared footer across the
  marketing family + landing nav.
- Prices **USD before tax**; **Paddle is seller of record**; the receipt says Paddle. Static
  pages **light only**.
- Cancellation is by email to `hello@windmill.works`; self-serve cancellation from Settings is
  not built, and the page says so rather than implying a button that doesn't exist.

## 6. The page — free-first, meter-forward

`windmill.works/pricing`, built from the terms/privacy static shell, light only:

1. **Hero — "Windmill is free."** The header never leads with payment. The sub carries the
   whole truth — all three rooms free, the AI's work is the one paid thing, 30 tendings a
   month on the house, one flat plan past that. The price figure first appears at the
   meter/plan sections, never in the hero.
2. **Everything you do by hand is free** — a generous grid closing on "30 tendings a month,
   free."
3. **One meter: tendings** — what a tending is, with a live meter + receipts.
4. **One upgrade** — Windmill One as a single brand-soft card: $12/month, 300 tendings, Talk
   and full echoes, the beats (nothing deleted · can't overspend), the guarantee, the "not
   open yet" state, and an aside "That's the whole plan." Never a tier table.
5. **The fine print, said plainly** — Paddle, cost, when you run out, changing your mind
   (links Refunds).

The meter specimen must read as an **example**, not the viewer's own account (an "example" tag
+ an aside line), since the page is seen logged-out.

Never: a two-column Free-vs-One feature table, restated free features padding the plan card,
"upgrade to unlock", any surprise-overage language, any red, any countdown.

## 7. Ownership map

| Concern | Owner |
|---|---|
| Register (never scare/sell/gate) | X4 · `../../roadmap/guidelines/honesty.md` |
| Brick reserved for deletion | `../../roadmap/guidelines/auth.md` (X6) |
| The tending meter, receipts, out-of-allowance pause (in-app) | `../../roadmap/guidelines/tending.md` §3–§6 |
| The echo lock and its honest cut | `../../journal/journal.md` §6 |
| What's sold, the identity, the page | **this doc** |

## Phone

One column, plan card first, ledger second, FAQ last. The **receipt ledger stays the hero** —
it is what teaches "a tending" — but scrolls as a list, not a table. The meter specimen keeps
its "for example" tag. Checkout hand-off obeys X8 §7's keyboard contract; the CTA lives in the
action lane and never sticks to the bottom edge over the home bar.
