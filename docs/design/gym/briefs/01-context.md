# Gym — context for the designer

## The product

A training log. You are in a gym, between sets, hands chalked, phone in one hand. You log what you
just lifted. Next session the app puts last time's numbers in front of you before you ask.

It is the third Windmill product, after roadmap (an RPG skill tree for goals) and journal (a
night-canvas daily journal), behind one account in one superapp with a product switcher.

## The user, named

A lifter who follows a written barbell program. Three to five sessions a week, the same movements
for months, weight going up in small steps. Squat, bench, deadlift, press, rows, chins. Not a
class-goer, not a beginner looking for guidance. This person knows what they are doing and wants the
app to get out of the way.

## The thesis

The training log is an endpoint the lifter's own Claude or ChatGPT reads over MCP. That agent knows
their last twelve weeks of squats, drafts next block's progression, and the change arrives in gym as
a typed diff they tap to apply. **The model proposes, the human applies.**

`Coach` is a second door onto the same engine. It can create requested routines and append useful
user-provided insights to Notes. Changes to existing routines require human Apply; Coach cannot
edit logged sets or frozen plans. Its tone is friendly, informal and grounded in training records,
without unsolicited check-ins, grades or streaks. The conversation contract is `09-coach.md`.

## The two surfaces

The phone owns the **open** session — workout mode, keypad, ladder, sticky carry-forward, elapsed
clocks, wake lock, the offline flush queue. All of it needs a device that is with you, awake, and
able to log in a basement with no signal.

The web owns everything retrospective and prospective — the log, routines, MCP connect, settings,
the past-workout door. There is no gym export; the shell's account export is the shell's. **The
web never finishes a live session:** only the device holding
the offline queue knows every set landed. A session closes itself after four hours idle and stamps
its end at the last set.

One workout is open per account, so the past-workout door is refused while one is open. Refuse it
on the client, with the reason said plainly — never as a server error the lifter has to interpret.

## Constraints

- One hand, sweaty, mid-set. Big targets, the primary action under a thumb on a large phone, nothing
  important in the top corners.
- Design the phone. Landscape does not matter; the desktop is a centred column.
- Gym's palette is scoped to `.gym-root`. It never touches the shell or the other two products.
- The shell is not yours: account seat, sign-in, settings page, billing, sessions, export and
  delete. Gym registers a settings *section*.
- The design system is yours — tokens, type, motion, components. Reach for them before inventing.

## Vocabulary

- **set** — one entry: exercise, weight, reps, timestamp. The atom.
- **session** — one visit to the gym; a list of sets.
- **exercise** — a movement with a stable identity (Back Squat), not a typed string.
- **routine** — a named ordered list of exercises you can start a session from.
- **plan snapshot** — what the routine said at the moment the session started. Frozen.
- **e1RM** — estimated one-rep max, Epley: `weight × (1 + reps / 30)`.
- **set kind** — warmup · working · drop · failure. Only working sets count toward anything.
- **note** — a title and a body a lifter writes *for* Coach. Not a set's note, and not a preference.
- **bodyweight** — a lifter's own weight on a day. Never a load; loads are signed, bodyweights are not.

Do not use: workout *template* (it is a routine), *tracker*, *fitness*, XP, levels, badges, streaks.

**On the word *coach*.** It names exactly one thing: the room. The link a lifter hands to a *human*
coach is **"Share this workout"** and carries the word nowhere. Two meanings of one word on one
surface is a confusion this room does not ship — and *session* could not take the job either, since
Windmill already ships a user-facing session in the account, and this file uses the word for one
visit to the gym. The finish receipt's primary, **"Share with Coach"**, names the room and nothing
else, which is why the human-coach link is not drawn beside it (`16-the-workout.md`).

## The feeling

Roadmap is ceremony and unlocking; journal is quiet and warm. Gym's controls are matter-of-fact,
dense and legible at arm's length. The phone finish receipt permits **Well done.** or
**Ended early.**, plus one emphasized line for a true PR (`16-the-workout.md`). Keep factual
progress distinct from Coach's supportive conversation; neither uses grades or streaks.
