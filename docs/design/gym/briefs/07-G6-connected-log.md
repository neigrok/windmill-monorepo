# G6 · The connected log — the paid surface

**Blocks:** `gym-mcp` (phase 2, M). This is the product's differentiator and its only paid surface.
**Read `01-context.md` first if you skipped it.** The central instruction: **there is no chat UI in
this product.**

## The bet

Every competitor sells "free tracker, paid AI coach in a chat tab". Windmill already runs an OAuth
2.1 MCP server, so gym sells something none of them can:

> **Your training log is an endpoint your own Claude or ChatGPT can read.**

The user connects gym to the agent they already use and pay for. That agent knows their last twelve
weeks of squats. They ask it — in their own tool, in their own words — to plan the next block, and
the change comes back into gym as a **typed diff they tap to apply**.

We build no chat, no streaming, no model picker, no API key field, and we pay for no tokens.

## Why this is a design problem, not a plumbing one

The mechanism exists and works (roadmap already exposes 27 MCP tools; there is a connect workbench
and an OAuth grant screen). What does not exist is **the explanation**. "Connect your training log
to your AI over MCP" is a sentence that means nothing to a lifter, and it is the paid surface, so it
has to land.

Three things to design:

### 1. The pitch

Wherever gym asks someone to become a subscriber, this is the value. The design problem: make the
capability legible to a person who has used ChatGPT and never heard of MCP, without a diagram of a
protocol. What can they *do* the morning after they connect? What does the very first useful
exchange look like? Show it — a concrete example beats an explanation.

Honest constraint: this only works for people who already use Claude or ChatGPT. Design for the ones
who do; do not pretend the rest are the audience.

### 2. The connect moment

There is an existing OAuth grant + connect workbench in the shell. Gym's job is the framing around
it: what is being granted, in the user's words (read your training log; propose changes you approve),
what is not (it cannot change your program by itself), and how to disconnect. Trust here is the whole
product.

### 3. The proposal — the most important artefact in this brief

An agent proposes a change to a routine. It arrives in gym as a **diff the user reviews and applies**.
Design that object:

- **What changed**, old → new, per line. Add exercise, remove exercise, change sets/reps/weight,
  reorder. Values that did not change are not shown.
- **A one-line summary** of the whole proposal, in plain words.
- **Apply and Dismiss.** Nothing is applied until the tap. Applying is atomic — all of it or none.
- **Where it lives.** Notifications do not exist in this product. Does a pending proposal wait on the
  routine? On a home surface? How does someone find out that their agent left them something?
- **After the tap.** The proposal becomes history: what was applied, when, from where. A record, not
  a disappearing toast.
- **Rejection.** Dismissing is a normal outcome and needs no justification.

The rule underneath all of it: **the model proposes, the human applies.** This is the one idea worth
keeping from Lift's coach, and it matters more here because the agent on the other end is not ours.

## The paid boundary

The log is free — logging, history, routines, PRs, export. All of it, forever, no gate.

Windmill One is one subscription across all three products (it already gates roadmap's tending and
journal's echoes and voice). Gym's contribution to it is the connected log. Design the gate honestly:
where a non-subscriber meets it, what they see, and — critically — **never a broken promise**. Lift's
paywall sold a feature that unconditionally threw an error when a paying user tried it; that is the
failure mode to design against.

No price is open yet. Do not design a pricing table.

## What to deliver

The pitch surface with a concrete first-exchange example, the connect framing around the existing
grant, the proposal diff in all its states (pending, applied, dismissed, historical), where a pending
proposal lives, and the subscriber boundary.
