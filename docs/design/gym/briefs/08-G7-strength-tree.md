# G7 · The strength tree — gym × roadmap

**Blocks:** `strength-tree`. A concept brief, not a screen brief. It may come back as "not yet" —
that is a valid outcome and worth knowing early.

## The observation

Strength progression is a prerequisite graph.

- bodyweight dip → weighted dip → muscle-up
- 60 kg squat → 100 kg squat → bodyweight×2 squat
- strict press → push press → handstand push-up

Windmill already ships a hand-rolled animated WebGL2 renderer for exactly that structure: roadmap,
where completing a node lights the ones it unlocks.

## The rule that makes it legal

Products never depend on each other — gym cannot import roadmap and roadmap cannot import gym. So
**gym publishes and never imports:** it emits an achievement (this exercise, this weight, these
reps), or exports a tree in the paste grammar roadmap's paste-import already plants. The coupling is
the user's account and the user's own hand, never a code dependency.

The design consequence: this is not "gym renders a tree", it is "gym hands roadmap something true".

## The questions to answer

1. **Who authors the tree?** We do (a canonical strength tree shipped as a starter, the way
   roadmap's starter quests work), the user does (they build their own progression in roadmap and
   gym lights it), or their agent does over MCP.
2. **What counts as unlocking a node?** One set at the weight, a session, three sessions? A working
   set, never a warmup or a failed rep. A node that lights unearned destroys the whole idea.
3. **What does the lifter see, and where?** Inside gym, inside roadmap, or in the switcher between
   them. What is the smallest version that is real — possibly just "your squat crossed 100 kg" as a
   node completing in a tree the user already has.
4. **Does this survive contact with a written program?** Our user follows 5/3/1 or GZCLP. If a
   strength tree is decoration next to the program they already run, say so and we cut it.

## Tone

Roadmap's tree is ceremonial and earns it; gym is matter-of-fact. If a strength tree makes gym
gamified, it is wrong. Streaks, XP, levels and badges are cut in gym, and a skill tree must not
smuggle them back in. The lifter's own progression is already the reward; the tree's job is to make
a two-year arc visible in one glance.

## What to deliver

A concept, a recommendation on the four questions, and the smallest honest version — plus a clear
"not yet" if that is the right call.
