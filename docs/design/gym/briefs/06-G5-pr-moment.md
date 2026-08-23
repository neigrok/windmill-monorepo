# G5 · e1RM, PRs, and the end of a session

**Blocks:** `pr-line` (phase 2, S). Depends on set kinds, because a warmup single is not a PR.

## The empty slot

The words **PR**, **record** and **streak** appear nowhere in Lift's codebase. Its end-of-session
screen showed three descriptive numbers — duration, volume, set count — and a button to ask an AI
about them. That is the biggest unclaimed moment in the product: the one time a lifter is guaranteed
to be looking at the phone with the work already done.

Meanwhile Lift *computed* estimated 1RM (Epley: `weight × (1 + reps / 30)`) inside its coach's tool
output and **never once showed it to a user**. It had the number and threw it away.

## What to design

**The finish screen.** What a session says about itself when it ends. Facts, and at most one line of
meaning. Candidates for the meaning line: a new e1RM on a main lift, a rep PR at a given weight, a
first-time-at-this-weight, or simply "heavier than last Tuesday". Decide what actually deserves the
line, and what happens on the many sessions where nothing does — a session that is merely *the work*
is the normal case and must not read as a failure.

**The PR line itself.** One line. Not confetti, not a modal, not a share sheet. This product is
matter-of-fact, and the credibility of the loud moment depends on how rarely it fires. Define what
counts as a PR precisely enough that it can be implemented:

- best e1RM for a movement,
- most reps at a given weight,
- heaviest weight for any reps,
- and what a warmup, a drop set, or a failed set does to each (nothing — they are excluded).

**e1RM as a first-class number.** Where does it live outside the finish screen? It is the only
metric that compares 5×100 against 3×110 honestly.

**"vs last time".** Design the comparison that runs on the finish screen and in session detail.
Volume alone lies (four light sets beat three heavy ones); propose better.

## The tone bar

A lifter who trains four times a week for a year sees ~200 finish screens. Design for the 190th, not
the first. Nothing that would embarrass someone at 6am, nothing that congratulates them for showing
up, nothing that implies a session without a PR was wasted.

## Explicitly cut

Streaks. XP. Levels. Badges. Trophy cabinets. Sharing to social. Weekly recap emails (that is
`gym-nudge`, later, and it is a nudge, not a report card).

## What to deliver

The finish screen in its three cases (a PR, a good-but-unremarkable session, a short or aborted one),
the PR line, the e1RM treatment, and the "vs last time" comparison.
