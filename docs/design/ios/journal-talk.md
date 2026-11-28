# Talk — iOS Journal

Status: ✅ Ready for dev, approved by the owner on 2026-11-28; 03.34P is a 🧪 proposal. Nothing is
built. Behaviour is [Journal Talk](../../foundation/journal-talk.md)'s; this
file holds what a person sees on the iPhone and every word Talk says there.

The boards are in [03 · Windmill One — Talk and Echoes](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=259-1850)
on the Journal file's iOS page, each Dark and Light: 03.11P–03.33P, and 03.1Pb, 03.2Pb and 03.7Pb,
which replace the archived 03.1P, 03.2P and 03.7P. 03.34P, an Undo that changed nothing, is a
proposal beside them. Their [NOTE](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=340-4901)
names the SwiftUI element of every part. The parts are three components on the file's Components
page: the bottom bar during a take (`336:103`), the Talk line (`336:150`) and the band (`336:168`).

## The fixture

Every board draws Saturday 26 September. Today's page reads *Short walk, then an early night. The
rain had stopped by six and I finally finished the book.* The take says *Walked the long way round
the park. The light was low and gold, and for once I didn't reach for my phone.*, and near ten
minutes goes on *Then soup, and the radio on low. Tomorrow I want to walk it again.* The allowance
returns on 1 October. The words are made up.

## Three parts

Talk draws three things and no sheet of its own.

- **The button.** Talk stands beside Write in the bottom bar's one glass capsule, signed in or out
  (03.11P, 03.12P). While a take runs the capsule holds one button, Stop with the take's time, and
  Write is absent because the page takes no typing.
- **The Talk line.** One stock `Label` under today's words, only while a take runs. Its icon is the
  state: the system spinner while connecting and finishing, the `waveform` symbol moving with the
  microphone's level while listening. Its title is the state word over the disclosure.
- **The band.** The room's `RoomTransient`, above the bottom bar as 02.2P draws it. Talk says here
  what it says when no take runs: why it cannot start, why a take ended, and Undo. One sentence in
  ink and at most one control. It leaves by its control, a swipe down, the next press of Talk or
  Write, or when the room is left, and runs no timer.

Doors are sheets and are not Talk's. Signed out, a press opens the Shell's sign-in door, which says
first that Talk is part of Windmill One (03.12P), and Talk goes on to the checks after sign-in.
Without Windmill One it opens the store door the [subscriptions](../../foundation/subscriptions.md)
work designs. Talk has no Live Activity and nothing in the Dynamic Island, since a take ends when the
app leaves the foreground.

## The take

- **Connecting** (03.13P). The microphone is closed. The Talk line shows the spinner and
  *Connecting…* with the disclosure, so a person reads it before a word is spoken. The capsule holds
  Stop alone.
- **Listening** (03.14P, 03.15P). The spinner becomes the level, the capsule grows the take's time
  and one haptic plays. Words appear on today's page after a blank line. Settled words are
  `journal/ink`. Unsettled words are `journal/ink-dim`, the last run before the Talk line, and turn
  to ink in a 200 ms fade when their turn settles.
- **Without colour or motion** (03.16P). Differentiate Without Colour adds a dotted underline to
  unsettled words. Reduce Motion drops the fade and holds the level still.
- **A bridge** (03.23P). Nothing is said. The level goes from the lamp to ink-dim while audio is
  held, and returns when the words catch up.
- **The last minute** (03.19P). At nine minutes the time in the capsule turns from elapsed to left,
  in the same ink, size and place, with one light haptic. It is the take's own clock: it changes no
  colour, does not pulse, carries no offer, and Talk can be pressed again as soon as the take ends.
- **Ending** (03.17P). Stop closes the microphone at once. The Talk line reads *Finishing…* while
  the last words settle, and Talk and Write are back, disabled, until they have.
- **Ended** (03.18P). The take's words are lit with `journal/lamp-soft` for as long as the band
  offers Undo, so a person sees what Undo removes. Undo returns the page to exactly what it was
  before the take. It is offered once, until the person writes or talks again or leaves the room.
- **Ended by itself** (03.20P–03.22P, 03.24P). The words stay, lit, and the band says why with Undo.
  A take that wrote nothing has the dismiss xmark and no Undo.
- **The screen stays awake.** While a take runs the phone does not lock itself
  (`UIApplication.shared.isIdleTimerDisabled`), so Auto-Lock cannot send the app to the background
  and end a take. The setting is given back the moment the take ends.
- **The microphone.** With Bluetooth earbuds worn, the earbuds' microphone records; with none, the
  phone's.
- **Largest text** (03.28P–03.31P). The page and the Talk line scale together, the band stacks its
  sentence over its control, and the bar's buttons keep their size with the Large Content Viewer.

## Words

### The disclosure

*Windmill keeps no audio. The service that writes it down keeps it for 30 days.*

It stands in the Talk line from the moment a take connects until it ends. No provider is named
where Talk is offered; the privacy page names it.

### The sign-in door, opened from Talk

The Shell's door with Talk's reason over its own doors (03.12P):

*Talk is part of Windmill One.* · *Sign in to use it on an account that has it.*

It holds for a person whose account has Windmill One and for one whose account does not, and it
offers nothing to buy.

### The microphone permission text

`NSMicrophoneUsageDescription`, shown by the system the first time a take would start (03.1Pb):

*Talk uses the microphone to write what you say on today's page. Windmill keeps no audio. The
service that writes it down keeps it for 30 days.*

The system asks only when every check before the microphone has passed, so nobody is asked for the
microphone and then shown a door.

### While a take runs

| Where | Words |
|---|---|
| The Talk line, connecting | *Connecting…* |
| The Talk line, listening and during a bridge | *Listening* |
| The Talk line, ending | *Finishing…* |
| The capsule | the time, *0:42*; in the last minute *0:42 left* |

### When a take ends

The band, with *Undo* when the take wrote words.

| Cause | Sentence |
|---|---|
| The person pressed Stop | *Added to today* |
| Ten minutes | *Talk stops at ten minutes. Tap Talk to go on.* |
| 15 seconds before midnight | *Talk stops just before midnight.* |
| The app left the foreground, said on return | *Talk stopped when you left Windmill.* |
| A call, an alarm or the assistant took the microphone | *Something else took the microphone, so Talk stopped.* |
| The microphone's device went | *The microphone disconnected, so Talk stopped.* |
| Capture failed | *Talk lost the microphone and stopped.* |
| The service stopped listening, `idle` | *Talk heard no words for a while, so it stopped.* |
| The allowance ran out, `subject_exhausted` | *Your AI allowance is used. Talk returns on 1 October.* |
| The period is not funded, `funding_required` | *Talk returns when your Windmill One period is paid.* |
| `paused`, `restarting`, `provider_unavailable`, a defect | *Talk is not available now.* |
| `busy`, `rate_limited`, `accounting_unavailable` | *Talk is busy. Try again in a moment.* |
| The connection was lost and could not be bridged | *Talk lost the connection. The last words may be missing.* |
| A cut with a code Talk has no sentence for | *Talk stopped. Your words are on the page.* |
| The page is full | *Today's page is full. The last words did not fit.* |

A take the person ends before it wrote a word shows no band.

🧪 Proposal, 03.34P: an Undo that changed nothing. Undo writes only while the page is exactly as the
take left it. If the page changed on another device in between, Undo removes nothing, the words stay
unlit, and the band says *Couldn't undo. The page changed.* with the dismiss xmark.

### When Talk cannot start

The band answers the press before the microphone opens (03.25P–03.27P, 03.2Pb, 03.7Pb, 03.32P,
03.33P). No alert, no sheet, no red. The checks are made in this order and Talk stops at the first
that holds; the microphone comes after every check on the account.

| | Check | Sentence | Control |
|---|---|---|---|
| 1 | Signed out | none: the sign-in door opens | |
| 2 | Offline | *Talk needs a connection. Typing works offline.* | dismiss |
| 3 | This build is retired | *Update Windmill to use Talk.* | *Update* |
| 4 | No Windmill One | none: the store door opens | |
| 5 | Windmill One with no funded period | *Talk returns when your Windmill One period is paid.* | dismiss |
| 6 | Allowance used | *Your AI allowance is used. Talk returns on 1 October.* The day is the allowance's `budgetResetsAt`; with no day, the first sentence alone. | dismiss |
| 7 | The microphone | asked by the system the first time; refused, *The microphone is off for Windmill.* | *Open Settings* |

With every check passed Talk opens the take, and the service can still refuse it:

| | Answer | Sentence | Control |
|---|---|---|---|
| 8 | Another request running | *Another AI request is still running. Nothing was recorded.* | dismiss |
| 9 | Busy | *Talk is busy. Try again in a moment.* | dismiss |
| 10 | Talk is off | *Talk is not available now.* | dismiss |
| 11 | A defect, which is also reported | *Talk is not available now.* | dismiss |

Two more are answered at the press, before the microphone:

| State | Sentence | Control |
|---|---|---|
| The page is already full | *Today's page is full.* | dismiss |
| The last 15 seconds of the day | *Talk starts again after midnight.* | dismiss |

### VoiceOver

| Element | Label | Value or hint |
|---|---|---|
| Talk | *Talk* | hint *Writes what you say on today's page.* |
| Stop | *Stop* | value the time, *42 seconds*, then *42 seconds left*; read on focus, never each second |
| The Talk line | the state and the disclosure as one element | |
| The band | its sentence, then its control | |

- Magic Tap starts and ends a take.
- Unsettled words are hidden from VoiceOver; settled words are the page's text.
- Nothing is announced while the microphone is open, since the take captures with echo cancellation
  off and a spoken announcement could be written on the page. Haptics carry the start, the last
  minute and the end. Once the microphone has closed, the band's sentence is announced.

## Haptics

One each: `.start` when the microphone opens, `.impact(weight: .light)` at one minute left, `.stop`
when the person ends a take, `.warning` when a take ends by itself, `.error` for a refusal at the
press. No sound.
