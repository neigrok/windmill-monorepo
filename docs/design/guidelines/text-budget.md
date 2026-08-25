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
| **A decision screen's chrome, first paint** | **≤ 40 words** — the ten-second decision window | FINDING |
| **A reference surface** | budgeted **per row**, not per screen — see below | — |
| **A screen where half the words get read at all** | **≤ 111 words**, everything included | FINDING (derived) |
| Section footer / caption | ≤ 12 words, **at most one per screen** | — |
| Empty state | a line and an action, ≤ 15 words together | — |
| Refusal | ≤ 12 words, **and it names the way out** | — |

The rows without a type are ours, set to fit the ones that have one.

## Cutting words is a lever. It is not the lever.

This is the part most brevity advice gets wrong, and the evidence against it is far larger than the
evidence for it.

- **Salience beats brevity, by 2.7×.** A regulator's randomised trial on **~200,000 real letters**
  across 128 cells: cutting 40% of the text roughly doubled response (+1.4 points on a 1.5% base).
  Making the key information **salient** added **+3.8 points**. Doing both together returned *less
  than the sum* — they partly substitute.
- **Concrete beats short.** A central bank's trial, n=2,275: halving a letter from 1,069 to 535 words
  was **not significantly better**. A 407-word version that was **relatable** — concrete, second
  person, tied to the reader's own life — beat everything by **+42%**, and helped disengaged readers
  most.
- **Cutting padding helps; cutting structure-bearing words hurts.** In the classic jury-instruction
  work, comprehension *rose* while readability scores got *worse*, because the researchers **added**
  words to make relationships explicit.
- The plain-language standard itself spends only about **7%** of its guidance on word choice.

So the order of operations is: **make the one thing that matters impossible to miss, say it
concretely and in the second person, and only then cut.** A short screen where the important fact is
not salient has bought very little.

*(The often-quoted 1997 finding that halving word count improved usability 58% is real but is n=51,
desktop web, and a composite score against a deliberately promotional control. It is the weakest
evidence here, not the strongest. And the famous "calls fell from 1,110 to 200 after a plain-language
rewrite" is **not a measured result** — five counsellors estimated it a year apart and kept no log.
Do not cite it.)*

## Two things not to chase

**Reading grade.** Four versions of the same material at grades 8, 10, 12 and 14, n=2,639: **no
difference in knowledge, ease or trust.** Six grade levels, nothing. The best-known formula was
calibrated on 531 Navy enlisted men reading Navy manuals in 1975, uses only sentence length and
syllable count, and breaks entirely on lists and UI strings — a good screen may contain no complete
prose sentence at all.

**"Fewer words" as a label rule.** A government team's own A/B tests: *"Finish"* beat *"Give
feedback"* six to one — by matching intent, not by being shorter — and the **longer** *"find contact
details"* beat *"start now"* by 30% on mobile. The defensible rule for a label is **name what will
actually happen**.

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
performance**.

**How badly layering can fail, measured at national scale:** a government site put a plain list of
phone numbers behind one question — a single layer over the exact information people had come for —
and **half of roughly 800,000 monthly users never reached any output page at all.**

### The easiness effect — the one that should worry a product like this

Making a text plainer raises a reader's **confidence in their own understanding faster than it raises
the understanding**. It also makes the source seem more credible and **reduces the felt need to check
with someone who knows more**. Replicated for video in 2025 (n=179); a debiasing attempt did not fix
it. The central-bank study independently warned that participants "frequently overestimate their
understanding".

For a product whose whole position is that it tells people the truth, that is a real hazard rather
than a curiosity: **a beautifully plain disclosure can leave someone more confident and less curious
without leaving them better informed.**

> **So "it reads clearly" is not evidence a disclosure landed. Test recall, or test behaviour.**

The mitigation that fits this brand: keep the surprising part **concrete and second-person** — *"any
agent you connect can read these too"*, not *"notes may be accessible to connected integrations"* —
because concreteness is the property that actually moved comprehension in the trial above, and it is
the one that survives being short.

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

   > **A move is not done until the destination is drawn.** This wave learned it the hard way: two
   > true facts — a daily allowance and a note ceiling — were taken off a screen "to the moment they
   > bite", and nobody drew that moment. They were not moved. They were deleted, with a rationale
   > attached. If you cannot point at the screen the fact landed on, you have not moved it, and the
   > honest label for what you did is *cut*.
3. **It is structure explaining itself.** *"Drag to reorder"* under a drag handle. Delete the sentence
   and keep the handle.
4. **It is two sentences doing one job.** Merge, or move one of them to the screen whose question it
   answers.

## Decision surfaces and reference surfaces are not the same screen

The forty-word figure comes from a **decision window** — how long someone spends before choosing what
to do. It does not transfer to a screen nobody is deciding on.

A **settings list** is chrome by construction: every row is a label, and a lifter scans it for the one
row they came for. So is a log. Counting those screens against forty says only that they are lists,
which everyone knew.

> **A reference surface is budgeted per row, and per group.** Row label 1–3 words · row meta ≤ 8 ·
> **one caption per group, not per screen** · and each caption still ≤ 12 words.

The forty-word budget holds for anything where somebody is choosing or committing: an empty state, a
review sheet, a refusal, a first run, a chart they came to read.

This distinction was missing from the first draft, and it made three settings screens look like
failures for being settings screens.

## A board's numbers are a fixture, not a decoration

Pinning the **words** of a wave is not enough, and this project learned it the expensive way: a wave
that pinned 163 strings still drew nine classes of impossible screen, because nobody pinned the
**data**.

Every surface invented its own example session. Each one looked plausible alone. None of them
survived arithmetic:

- a session header claiming twelve working sets above five drawn ones,
- a tonnage that is not the sum of the sets beneath it,
- a note reading *three short* over a load that also missed its target, when the code returns the
  load branch first and can never print both,
- a fix sheet naming *set 3* of a movement the session does not contain,
- a caption naming a routine on a screen whose own title says there is none,
- a queue showing set 3 landed while set 2 is still owed, in a lane the store forbids skipping.

Every one of those is a number that had to agree with another number and did not.

> **A wave draws from ONE fixture: a single example — a session, a routine, a log — written down
> before anything is drawn, with every derived value computed from it.**

The fixture carries the raw facts and the things derived from them: the sets, and then the working
count, the tonnage, the top estimate, the set numbers, the plan snapshot and the note each set earns
against it. **Derived values are computed by the rules the product uses, not chosen to look right.**

Two properties make it worth the effort:

1. **A reviewer can check arithmetic.** "Does the header equal the sum of the rows" is a question
   with an answer, unlike "does this look like a plausible session".
2. **Three surfaces drawing the same fixture agree by construction**, instead of agreeing only where
   somebody remembered to compare them.

**Where a board needs a state the fixture does not contain** — an early finish, an empty log, a
refusal — it extends the fixture explicitly and says so, rather than quietly inventing a second
session that contradicts the first.

## Checking

On a decision surface, count the chrome words on first paint. Over forty, something is doing a job the
design should be doing. On a reference surface, count captions per group instead.

**Stacking is the failure mode to watch for.** Four true sentences in a column is not four times as
honest as one — it is a paragraph, and a paragraph is not read. A screen that gains a fifth caption
has usually lost a disclosure it thinks it still has.
