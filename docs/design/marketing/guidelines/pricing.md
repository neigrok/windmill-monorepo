# Windmill Pricing — pay for tending, not for the product (#15, revised)

The canonical spec for the paid layer.

> **Principle: sell the new power, never re-sell a default.** The product is
> free forever. The one thing that costs money is
> **tending** (the AI that plants and reshapes your tree). Free gives you a real
> monthly allowance; **Windmill One is one flat plan — $12/month for a generous
> monthly allowance (300 tendings).** One plan, one price, no tiers.

**Why an allowance, not literal "unlimited":** every tending is a **server-side
agent loop that bills us tokens per run** — not a $0-marginal action. Flat-rate
"unlimited" on a per-use-cost feature loses money on exactly the heaviest users
who pay (flat-rate unlimited would give away something costly). A large allowance ("300 a month")
reads nearly as clean as "unlimited" and doesn't bleed on power users.

**The numbers are settled** (2026-08-02, by the owner): **30 free · 300 on
Windmill One · $12 USD/month**. They were provisional while per-run token cost
was unmodelled; they are not any more, and the live Paddle product carries $12
independently. Anything in this project still hedging them is stale.

Shippable page: `ui_kits/marketing/pricing.html` (light only) + `refunds.html`.
The in-app meter and the out-of-allowance pause live in `tending.md` §6 (the
fourth refusal face) and the settings usage row.

---

## 1. What's free (all of it)

Everything except the AI doing the work: unlimited trees and steps, **unlimited
hand editing**, **private by default**, share and fork, all nine quests, export,
every device, the MCP server and an API key. Plus **30 tendings every month,
free** — a real allowance, not a teaser. There is **no usage meter on the
product itself**; only tending is counted.

**Tending needs an account, and it is the only thing that does.** The free 30 are
30 *for a signed-in account*: a tending is a server-side agent loop that bills
real tokens, the allowance is metered per account, and a device id is not an
identity anyone can be held to. **There is no anonymous tending.** Everything
above this line works signed out, forever. This makes tending an *account verb*
in `auth.md`'s sense — the door opens at the moment it is asked for and resumes
after — never a wall, and never a reason to ask for an account on launch.

## 2. What's sold: tendings (the one meter)

- **A tending = one instruction to the AI** — "plant a 10k plan", "add a testing
  branch", "is this realistic?". One sentence, one tending, **one receipt** in
  the ledger. It maps exactly to `tending.md`'s "one sentence = one history step".
- **It's the only thing metered anywhere in Windmill.** Hand editing is unlimited
  and never counted.
- **Every tending is a visible receipt** — the meter is transparent, not a
  mystery counter. You can always see what you spent.

## 3. How you buy it: one subscription, no tiers

**Windmill One — $12/month — 300 tendings a month** (about ten a day). Plant,
reshape and review to your heart's content. USD, before tax. One plan; there is
no tier ladder, no add-on packs, no per-run pricing to forecast.

**Free stays at 30 tendings/month**; **Windmill One raises the allowance to
300.** Both reset monthly. The upgrade is "a bigger allowance," not a bundle of
restated features.

## 4. The identity — the honesty beats

1. **One price, one plan.** $12/month for 300 tendings — no tiers to compare, no
   usage to forecast. "That's the whole plan."
2. **Cancel any time.** From Settings, no retention call, no "are you sure"
   maze; keep Windmill One to the end of the period, then drop to Free.
3. **Nothing is deleted if you stop.** Drop to Free and your trees are
   untouched; **hand editing is always free**. Running out on Free pauses the
   robot, never the product — the `tending.md` §6.4 refusal face.
4. **Every tending is a receipt.** Transparent meter; on Free you always see
   what you spent.

**Colour rule (inherited):** terracotta = the buy verb + tending surface;
brand-soft = the Windmill One card; **gold** = "running low" nudge only; **brick =
never** (reserved for deletion, X6). Register: never scare, never gate
(`honesty.md`).

## 5. Non-negotiables (Paddle site-verify gates real checkout)

- The **30-day money-back guarantee** on the subscription, visible where money is
  asked. There are no packs to guarantee: they went with the withdrawn draft.
- **Refunds / Terms / Privacy** reachable from navigation — `refunds.html`
  shipped, in the shared footer across the marketing family + landing nav.
- Prices **USD before tax**; **Paddle is seller of record**; the receipt says
  Paddle. Static pages **light only**.

## 6. The page — free-first, meter-forward

`windmill.works/pricing`, built from the terms/privacy static shell, light only:
1. **Hero** — **"Windmill is free."** The header never leads with payment (founder register
   call, 2026-08-01: we are mission-driven; a pay-verb headline reads as a squeeze). The sub
   carries the whole truth — all three rooms free, tending is the one
   paid thing, 30 a month on the house, one flat plan past that. The price figure first
   appears at the meter/plan sections, never in the hero.
2. **The product is free. All of it.** — a generous grid closing on "30 tendings
   a month, free."
3. **One meter: tendings** — what a tending is, with a live meter + receipts
   ("you always see what you spent").
4. **One upgrade** — Windmill One as a single brand-soft card: $12/month, 300
   tendings a month, the two beats (nothing deleted · cancel any time), one CTA,
   the guarantee, and an aside "That's the whole plan." Never a tier table.
5. **The fine print, said plainly** — Paddle, cost, when you run out (allowance
   pauses; hand editing free), the guarantee (links Refunds).

The meter specimen must read as an **example**, not the viewer's own account (an
"example" tag + an aside line), since the page is seen logged-out.

Never: a two-column Free-vs-One feature table, restated free features padding the
plan card, "upgrade to unlock", any surprise-overage language, any red, any
countdown.

**Status — published, and selling something no user can reach yet.** This page
shipped on 2026-08-02 with the settled name and figures. Tending itself is still
**dark**: `TENDING_ENABLED` defaults to false and must be set explicitly, so no
user can run one. The page therefore advertises a feature that does not yet
answer. That is a live tension with the mission's own "no copy that promises what
the product doesn't do", it is **the owner's call and not the build's**, and it is
recorded in the consistency ledger rather than quietly resolved either way. The
honest exits are two: arm tending, or say plainly on the page that it is coming.

## 7. Constants — copy into the build

```
PRINCIPLE  sell new power (tending), never re-sell a default (the product is free)
FREE       whole product + unlimited hand editing + private by default, ALL signed out forever
           + 30 tendings/month — but tending needs an ACCOUNT; there is no anonymous tending
METER      one tending = one instruction = one receipt · only thing counted · hand editing never counted
PLAN       Windmill One = $12/month = 300 tendings/month · one plan, no tiers, no packs · allowance NOT literal-unlimited (per-run token cost)
BEATS      one price/one plan · cancel any time · nothing deleted if you stop · every tending a receipt
RUNOUT     allowance pauses (30 Free / 300 One), trees untouched, hand editing free, resets monthly
NUMBERS    30 / 300 / $12 SETTLED 2026-08-02 · meter = example, not viewer's account
STATUS     page published · tending still dark (TENDING_ENABLED off) · arming it is an owner call
LEGAL      30-day money-back · cancel any time (keep to period end) · Refunds/Terms/Privacy in nav · Paddle seller of record · USD pre-tax · light only
COLOUR     terracotta = buy verb + plan surface · gold = running-low nudge · brick = never
```

## 8. Ownership map

| Concern | Owner |
|---|---|
| Register (never scare/sell/gate) | X4 · `honesty.md` |
| Brick reserved for deletion | `auth.md` (X6) |
| The tending meter, receipts, out-of-allowance pause (in-app) | `tending.md` §3–§6 |
| What's sold, the identity, the page | **this doc** |

## Phone

One column, plan card first, ledger second, FAQ last. The **receipt ledger stays
the hero** — it is what teaches "a tending" — but scrolls as a list, not a table.
The meter specimen keeps its "for example" tag (it must never read as the
viewer's account). Checkout hand-off obeys X8 §7's keyboard contract; the CTA
lives in the action lane and never sticks to the bottom edge over the home bar.
