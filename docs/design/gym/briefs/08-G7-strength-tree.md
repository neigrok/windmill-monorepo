# G7 · The strength tree — gym × roadmap

**Blocks:** `strength-tree` (phase 3, M). The brand bet, and the only idea in the plan a competitor
structurally cannot copy.
**This is a concept brief, not a screen brief.** It may come back as "not yet" — that is a valid
outcome and worth knowing early.

## The observation

Strength progression **is** a prerequisite graph.

- bodyweight dip → weighted dip → muscle-up
- 60 kg squat → 100 kg squat → bodyweight×2 squat
- strict press → push press → handstand push-up

And Windmill already ships a beautiful, animated, hand-rolled WebGL2 renderer for exactly that
structure: roadmap, an RPG skill tree where completing a node lights the ones it unlocks.

**A strength tree that lights up from sets you actually logged exists nowhere.** Not on the App
Store, not on the web. Every tracker draws line charts; none of them draw the thing a lifter
actually feels, which is that the work unlocks the next thing.

## The rule that makes it legal

Windmill's one architectural rule: products never depend on each other. Gym cannot import roadmap and
roadmap cannot import gym.

So the mechanism is: **gym publishes, gym never imports.** Gym emits an achievement — this exercise,
this weight, these reps — or exports a tree in the paste grammar that roadmap's already-shipped
paste-import plants. The coupling is the user's account and the user's own hand, never a code
dependency.

The design consequence: this is not "gym renders a tree". It is "gym hands roadmap something true,
and roadmap does what roadmap already does".

## The questions to answer

1. **Who authors the tree?** Three candidates, and the choice is the whole design:
   - *We do* — a canonical strength tree shipped as a starter, the way the nine starter quests work
     in roadmap.
   - *The user does* — they build their own progression in roadmap and gym lights it.
   - *Their agent does* — over MCP (`G6`), the agent that reads the log drafts the tree.
2. **What counts as unlocking a node?** One set at the weight? A session? Three sessions? A
   working set, never a warmup or a failed rep. Whatever it is, it must be honest — a node that
   lights when you did not earn it destroys the whole idea.
3. **What does the lifter see, and where?** Inside gym, inside roadmap, or in the switcher between
   them? What is the smallest version that is real — possibly just "your squat crossed 100 kg" as a
   node completing in a tree the user already has.
4. **Does this survive contact with a written program?** Our user follows 5/3/1 or GZCLP. Does a
   strength tree help them, or is it decoration next to the program they already run? Answer this
   one honestly — if the answer is "decoration", say so and we cut it.

## The tone constraint

Roadmap's tree is ceremonial and it earns that; gym is matter-of-fact. If a strength tree makes gym
gamified, it is wrong. The lifter's own progression is already the reward; the tree's job is to make
a two-year arc visible in one glance, not to hand out achievements.

Reminder of what is cut in gym: streaks, XP, levels, badges. A skill tree must not smuggle them back
in.

## What to deliver

A concept, a recommendation on the four questions, and the smallest honest version — plus a clear
"not yet" if that is the right call.
