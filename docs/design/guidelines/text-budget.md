# Text budget — how many words an element may spend

Nobody reads a long-read in a product. The perfect screen needs no help text at all, and the next
best thing spends as little as it can and still be true.

This is the budget, what it is grounded in, and the one exception.

## The rule

> **Budget the chrome. Never budget the content.**

**Content** is what the person came for — an answer, a note's body, a movement name, a number, the
rows of a diff. Nobody resents the thing they asked for being long. Content is bounded elsewhere, by
its own caps.

**Chrome** is everything the product says *about itself*: titles, labels, captions, footnotes,
explanations, reassurances, empty-state prose, help. This is what the budget governs, and it is where
all the fat is.

## The test, before any number

**Delete every caption. What breaks?**

- Nothing breaks → it was decoration, and it stays deleted.
- An **affordance** became unclear → that is a **design failure**. Fix the control, not the sentence.
  *A permanent caption is a confession that the design did not carry its own meaning.*
- A **disclosure** was lost → it survives, as **one sentence, at the moment of consequence**.

The third case is rare. Most captions are the first two.

## The budgets

Typed, because the three kinds carry different weight. **FINDING** is measured research,
**GUIDANCE** is a platform's own instruction, **HARD** is where a system truncates.

| Element | Budget | Type |
|---|---|---|
| Tab / nav label | **1–2 words** (~11 characters is what the eye takes) | FINDING + GUIDANCE |
| Screen title | 1–3 words | GUIDANCE |
| Button | **1–3 words**, one line, never truncated | GUIDANCE |
| Alert button | 1–2 words, a verb | GUIDANCE |
| Row title | ≤ 6 words | — |
| Row meta line | ≤ 8 words, and **facts, not a sentence** | — |
| Snackbar / toast | **1 line**, 2 at most on a phone | GUIDANCE |
| Tooltip | 1 line, no wrapping | GUIDANCE |
| Any line of body text | **40–60 characters** | GUIDANCE |
| Notification title / body | **< 29** / **< 40** characters collapsed | GUIDANCE |
| **A glance** | **6–20 words** — 1.5–5 s at 238 wpm | FINDING |
| **A screen's chrome, first paint** | **≤ 40 words** — the ten-second decision window | FINDING |
| **A screen where half the words get read at all** | **≤ 111 words**, everything included | FINDING (derived) |
| Section footer / caption | ≤ 12 words, **at most one per screen** | — |
| Empty state | a line and an action, ≤ 15 words together | — |
| Refusal | ≤ 12 words, **and it names the way out** | — |

The rows without a type are ours, set to fit the ones that have one.

**The strongest single number:** in the cleanest experiment on this, **halving the word count
improved measured usability by 58%** — and concise, scannable and neutral together by 124%, against a
promotional control. It is 1997 desktop web with n=51 and a composite score, so quote it with those
caveats. Nothing since supersedes it.

## Disclosures — where honesty and brevity meet

Windmill states things other products hide. That is not negotiable. But the research is blunt about
what a long notice actually achieves:

- **17% of people paid attention to permissions during installation, and 3% could answer all three
  comprehension questions.** (2012, n=308 + 25.)
- Real people took a **median 18–26 minutes** to skim one privacy policy. (2008.)

> **A long true notice is not more honest than a short true one. It is less honest in effect,
> because almost nobody engages with it. Length is not honesty.**

Three things follow, and the second is the one that gets forgotten:

1. **One complete active sentence, carrying the surprising part.** Not the reassuring part — the part
   the reader would not have guessed.
2. **Short *and structured*.** Shortening prose alone measurably loses accuracy; a short **structured**
   notice performed as well as a long structured one and beat short prose significantly. Structure is
   what recovers the comprehension that brevity costs. Prefer a row, a label, a mark — anything that
   is not a paragraph.
3. **Two levels of disclosure, maximum.** In the study that measured it, the deeper layer bought
   nothing: people who opened the full policy did no better than those who did not.

And two warnings from the same work: **naive layering trades comprehension for speed** — hiding a
thing behind a control is not free — and **improved readability scores did not translate to improved
performance**, so a readability score is not the goal.

## The exception, stated once so nobody re-argues it

**If a thing cannot be said shortly and stay true, it stays long.** Truth beats the budget. Every
time.

That exception is narrow, and it is not a licence: before using it, check that the sentence is not
already said elsewhere on the screen, and that it belongs at this moment rather than the moment its
consequence arrives.

## Four moves, in order of how often they work

Almost every over-budget screen is fixed by one of these, and none of them deletes a true thing.

1. **It is already said.** A caption repeating a title, a subtitle, or the label on the button below
   it. Cut it.
2. **It belongs at the moment of consequence.** A quota explained before any of it is spent. A size
   limit shown to somebody with two of a possible ten. Move it to where it bites.
3. **It is structure explaining itself.** *"Drag to reorder"* under a drag handle. Delete the sentence
   and keep the handle.
4. **It is two sentences doing one job.** Merge, or move one of them to the screen whose question it
   answers.

## Checking

Count the chrome words on first paint. Over forty, something on that screen is doing a job the design
should be doing.

**Stacking is the failure mode to watch for.** Four true sentences in a column is not four times as
honest as one — it is a paragraph, and a paragraph is not read. A screen that gains a fifth caption
has usually lost a disclosure it thinks it still has.
