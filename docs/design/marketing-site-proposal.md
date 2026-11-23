# Marketing site proposal

A proposal for the public pages of windmill.works: their structure, the sitemap, how search engines
read them, their wording and their look. Nothing here is built. Wording is built only after the owner
approves it, and layout only from a Figma flow the owner marks ✅ Ready for dev. The drawings go in the
[Windmill · Marketing](https://www.figma.com/design/uWLMdVmzTcobOh8hbeem81) file.

The pages speak from [the idea](brand-foundations.md#the-idea) and keep every rule in
[Honesty](brand-foundations.md#honesty) and in
[what every channel keeps](../marketing/strategy.md#what-every-channel-keeps).

## What the pages are for

A visitor should learn four things, in this order, and each page owns one of them.

1. What Windmill is, what its three tools are and the one feature that leads each: the front page.
2. What one room does for one job: a page per room.
3. That the AI is theirs to choose: the page about using your own assistant.
4. How Windmill is paid for: the pricing page.

The pages built today open with three product bands. No sentence says what Windmill is: the front
page's main heading, "Three tools. One account.", is hidden in the rendered page.

## Sitemap

| Address | Its one job | Today |
|---|---|---|
| `/` | Say what Windmill is, name its three tools with the feature that leads each, and send the visitor to a room | Exists; opens with product bands |
| `/roadmap` | Any goal as a skill tree | Exists |
| `/gym` | A training log that remembers | Exists |
| `/journal` | A place to notice what happened | Exists |
| `/connect` | Use the assistant you already have | Exists as `/connect.html`, linked from footers only |
| `/pricing` | What is free, what One is, where the money goes | Exists as `/pricing.html` |
| `/about` | Why Windmill exists, what the name means, what it will not do | New |
| `/changelog` | What changed, with real dates | Exists as `/changelog.html`; Roadmap only, last entry July 2026 |
| `/gallery` | Roadmaps their owners listed in public | Exists |
| `/t/<id>` | One published roadmap, readable before any script runs | Exists; body and structured data are the front page's |
| `/privacy`, `/terms`, `/refunds` | Legal | Exist as `.html` |

- Addresses lose `.html`. The short address becomes the canonical one and the `.html` address
  redirects to it. Today it is the other way round.
- A page for guides is added only when the first real guide exists. A page without a useful artifact
  of its own stays unpublished.
- The header carries: Roadmap, Gym, Journal, Pricing, About. On the right: a quiet Sign in and one
  action. The light and dark switch moves to the footer.
- The footer is the whole sitemap in columns: Rooms · Your own assistant · Windmill (About, Pricing,
  Changelog, Gallery) · Legal, then Feedback and the appearance switch with three positions: Auto,
  Light, Dark.
- The front page's action is a choice of room. Today "Start free" opens Roadmap's start picker on a
  page about three rooms, and static pages send "Start your tree" to a different place than landings do.

## Wording

Rules for every string on these pages:

- It describes what a visitor can do today on the surface named. A number appears only when the code
  or a document that states it has been checked.
- The person is the subject and does the work. The AI guides: it gives clarity and guidance, helps
  keep the record and helps a person past what blocks them. No string says the AI "works for you" or
  "does it for you". Nothing frightens or belittles.
- Plain words, sentence case, short sentences. One idea per heading.
- Each room is named in full at first mention: Windmill Roadmap, Windmill Gym, Windmill Journal.
- One description per page, used for search and for social cards alike.

### Front page `/`

A stranger with no context reads, in the first screen, what Windmill is, what its three tools are and
the one feature that leads each.

| Part | Wording |
|---|---|
| Title | Windmill — a skill tree, a training log and a journal |
| Description | Windmill is where a person keeps growing in body, skill and mind. An AI-native training log, skill tree and journal. Use your own AI or ours. |
| Main heading | Windmill is where a person keeps growing in body, skill and mind. |
| Under the heading | An AI-native training log, skill tree and journal. · The AI guides. The work stays yours. Use your own AI or ours. |
| Strip · Windmill Roadmap | A skill tree for any goal. · Tell an AI your goal, get a skill tree. |
| Strip · Windmill Journal | A daily journal. · Your own words, echoed back. |
| Strip · Windmill Gym | A training log. · A coach that has read every set. |
| Roadmap section | Tell an AI your goal, get a skill tree. / Describe what you want to learn or build. Your own assistant, or Windmill's, writes the plan as a tree of steps. You edit it, and you do the steps. / Finish a step, the next unlocks · Start without an account · Share and fork → Start a tree |
| Journal section | Your own words, echoed back. / As you write, passages you wrote before appear beside the page when they speak to the same thing. Nothing is interpreted and nothing is graded. / Search by meaning · One page a night · Never graded → Write tonight |
| Gym section | A coach that has read every set. / Ask about your training and the answer comes from your whole log. It proposes a change to your routine, and nothing changes until you apply it. Use Windmill's Coach or connect your own assistant: the same log and the same rules. / It remembers last time · Honest progress · On your phone → Open the log |
| Your AI, or ours. | Either way the AI guides, and the work stays yours. |
| Your AI, or ours. · Yours | Connect the assistant you already have to Roadmap and Gym. It asks for the access it needs, and you approve it. → How to connect |
| Your AI, or ours. · Ours | Windmill's own AI is built in, with a free allowance. Windmill One raises the ceiling for one price. It is not on sale yet. → Pricing |
| Where it runs | Web: Roadmap, Gym and Journal. Android: Gym. iPhone: Journal and Gym, in beta. |

The page runs in that order: the heading with the two lines under it, the strip of three, one section
per room in the order Roadmap, Journal, Gym, then "Your AI, or ours.", where it runs, and the footer,
which is the sitemap. Each room section holds its heading, one paragraph, the picture that shows that
feature and three named features. The page carries no price number. Windmill One's line reads "It is
not on sale yet" until One can be bought, and becomes the offer on that day.

Before build, check each of these against the product, on every surface the page names:

- Windmill's own AI writing a tree. The pricing page says Roadmap's AI assistance is being redesigned,
  so "or Windmill's" may hold only at release. Until it holds, the Roadmap paragraph says "Your own
  assistant writes the plan as a tree of steps."
- Echoes appearing beside the page as a person writes.
- Where Coach is available.
- That "built in, with a free allowance" matches the allowance enabled.
- How a visitor gets the Android app and the iPhone beta, so "On your phone" and "Where it runs" can
  link to something that works.

### About page `/about`

| Part | Wording |
|---|---|
| Title | About Windmill — why it exists and what the name means |
| Main heading | Why Windmill exists |
| Statement | Machines can now do much of the work people do. In Windmill the AI gives clarity and guidance, helps keep the record and helps you past what blocks you. It does not do the work for you: the growing stays yours. |
| The AI guides, you decide | In Gym, Coach proposes a change and you apply it. After its first greeting it waits to be asked. |
| Yours and open | Bring your own assistant. It connects to Roadmap and Gym and asks for the access it needs. Journal has no door for one. |
| Never graded | No streaks, no scores, no countdowns. A day you skip is not coloured as a failure. |
| The name | A mill takes its time and grinds the grain into flour anyway. |

The page also holds what Windmill will not do, a public list drawn from the honesty rules, and how
Windmill is paid for. It has no section on who makes Windmill. A founder note appears only if the owner
writes one.

### Room pages

| Page | Keep | Proposed sections, heading / line |
|---|---|---|
| `/roadmap` | Title "Windmill Roadmap — any goal, as a skill tree"; heading "Any goal, as a skill tree" | See what comes first / Every step names what must be done before it. Finish one and what depended on it opens. · Start from a real path / the starter paths, with the roadmap.sh attribution · Your assistant builds it with you / Connect your own assistant and ask it for a plan. It writes the tree and you decide what stays. · Share a tree, or keep it / A tree is private until you publish it. Anyone with the link can view a published tree and fork it, and it can appear in the public gallery. · Plant your first tree |
| `/gym` | Title "Windmill Gym — a training log that remembers what you lifted"; heading "It remembers what you lifted." | Log the set. The rest is remembered. · Built for the barbell · Your own assistant can read your log / with a link to `/connect` · Coach proposes. You apply. / Coach is the room in the app for a lifter without an assistant of their own. It reads your log when you ask and proposes changes. Nothing changes until you apply it. · Where it runs · Log the next one |
| `/journal` | Title and heading "A place to notice what happened." | Write. Look back. Hear it back. · Find the feeling, not the word / Search understands meaning and runs on your device. · No share button / There is no way to share a page: the control does not exist. Echoes are found by a hosted AI model as you write, and the privacy page names it. · Echoes / Related passages from your own pages, in your own words. · Never graded / No streaks, no score, no count of missed days. · Write tonight |

Descriptions: `/roadmap` "Turn a goal or a learning plan into a skill tree with real prerequisites.
Finish a step and the next one opens. Free, and your first tree needs no account." · `/gym` "A training
log for barbell programs. Two taps between sets, and the next session opens with last time’s numbers."
· `/journal` keeps today's.

### Other pages

| Page | Proposed |
|---|---|
| `/connect` | Title keeps "Windmill Roadmap & Gym MCP server". Main heading "Bring your own assistant", replacing "Build Windmill with your AI tools". One exchange shown end to end: the request, the access asked for, the result, how to disconnect. Linked from the header's rooms, the front page and `/gym`. |
| `/pricing` | Main heading stays "Windmill is free." Sections: Everything you do by hand is free · Bring your own assistant and pay us nothing · Windmill One: our AI, one price · Where the $12 goes, in dollars: the AI allowance, the store's fee, running Windmill and the work · The fine print. The dollar split waits on the release's final AI allowance amount. A visible list of questions, with the matching structured data, lives here and nowhere else. |
| `/changelog` | Covers all three rooms. The front page shows the three latest entries, and shows the strip only while the newest entry is under 60 days old. |
| `/t/<id>` | Title "<tree title> — a skill tree on Windmill Roadmap". The tree's own heading, summary and first steps are in the first HTML. |

### Strings to remove or correct

These are false or unproven today, whatever the design becomes.

| Where | Says | Problem | Do |
|---|---|---|---|
| `/` description | "One account, one subscription." | Nothing is on sale | Remove |
| `/` structured data | Six questions and answers, one with "$12 a month" | No visible questions on the page; all six are about trees; landings carry no price | Remove from `/`; move questions to `/pricing` |
| `/roadmap` | "It can’t share roadmaps, delete them…" | `/connect` lists delete as a level an assistant can be granted | Say what each level allows |
| `/roadmap` | "Starter quests and paste-a-list are growing in" | Both ship | Remove |
| `/roadmap` | "The tree keeps score" | Reads against "never graded" | "keeps track" |
| `/gym` | Coach is "ten questions a day" | Pricing says allowance amounts are not announced; the allowance document describes dollar budgets | Remove the number until checked |
| `/gym` structured data | "Web browser" | The room also runs on Android | Name the true platforms |
| `/journal`, `/` | "kept only for you", "Nothing you write teaches anything" | The privacy page says pages go to a hosted model for echoes | Replace with the "No share button" lines above; keep the second only if a no-training term is verified |
| Pricing, refunds, terms, privacy | Paddle is the seller | One sells first in the App Store; the web sells nothing | Name the store a person will buy through |
| `404` page | A private tree link "now 404s" | The backend answers 200 with the front page | Make the answer a real 404 |
| Status badges | "Now in public beta", "Now open", none, and Terms' "public beta" | Four vocabularies | One true status per room, same words everywhere |
| Roadmap social cards | Three different descriptions | One page, three stories | One description |

## How search engines read the pages

In order of weight:

1. **Render the landings at build time.** A crawler that runs no script gets a badge, a heading, one
   paragraph and links. The whole page should be in the first HTML, with the live scenes mounting over it.
2. **One visible main heading per page**, equal to what the title promises.
3. **A published tree is its own page.** Its heading, summary and first steps in the first HTML; its own
   structured data or none; an unknown or private tree answers 404. Listed trees join the sitemap with a
   last-changed date.
4. **Structured data says only what is true.** Organization and WebSite on `/`. One SoftwareApplication
   per room with its real platforms and no offer until something is on sale. Questions only on `/pricing`.
5. **A social card per page**, drawn with the page: front page, each room, connect, pricing, about.
6. **Short canonical addresses** and one description per page.
7. **Links.** Every public page is reachable from the footer. `/connect` and `/gallery` gain links from
   the pages that talk about them.
8. **Naming.** "Windmill Roadmap", "Windmill Gym", "Windmill Journal" and windmill.works at first
   mention, so a search does not confuse Windmill with the unrelated developer automation platform.
9. **Small repairs.** The `robots.txt` comment names a route that does not exist; the web manifest and
   `package.json` describe the product in two more ways.

No keyword volumes are claimed here. Candidate terms (skill tree planner, workout log, journal) are
checked against real search results before a title changes for their sake.

## The look

The owner's reference is [Linear's homepage](https://linear.app/homepage): clean, thin lines, good
colour choices, professional and artisanal. Measured on that page and on ours on 2026-11-21:

| | Linear | windmill.works today |
|---|---|---|
| Opening | One sentence, one quiet line, then the product itself | Three product bands; no sentence about Windmill |
| Grounds | One for the whole page | Three in the first screen |
| Type | One family, two weights, headings 64 and 48px set tight | Baloo 2 headings, Nunito text, many 10 to 11px bold labels |
| Lines | 0.5px and 1px, white at 5 to 12% | 1, 2 and 2.5px |
| Shadows | Almost none | 22 on the front page |
| Text colours | Four greys; colour only inside the product pictures | Six, plus a hue per room in labels and links |
| Buttons | Small pills, 32px tall | Large terracotta pill, plus six other header controls |
| Section | Two-line heading left, one paragraph right, the product below, 128px of air | Eyebrow, heading, paragraph, link, picture beside |
| Proof of work | Changelog on the homepage | Changelog stops in July |
| Product pictures | Drawn as real interface | Live scenes, labelled as composed: already right |

**What to take.** The opening sentence. One ground per page, with each room's hue only inside its own
picture. Hairlines in place of shadows and card outlines. A four-step ink scale. Few type sizes and
tight display type. One job per section. Small, quiet controls. A footer that is the sitemap.

**The look is Instrument.** One typeface, Inter, for all page type, with few sizes and tight display
type. Day and night are both drawn, and a first visit follows the visitor's device. The footer's
appearance switch has three positions, Auto, Light and Dark, so a person can return to following the
device. The header carries
the approved mark, unchanged, with the word "Windmill" set in Inter; the full rounded logo stays for the
app icon and social cards. A night version of the mark, with the same shapes and a lighter hub and door,
is drawn for the owner's approval and is not used before it. The product pictures keep the product's own
typefaces, because they show the product as it is.

**What stays Windmill.** Warm paper by day and near-black by night, never Linear's cold grey. Terracotta
as the one accent. The pictures built from the product's own vocabulary, and their "composed" labels.
Every honesty rule.

**What it changes from brand foundations.** Inter in place of Baloo 2 and Nunito on the public pages.
The word "Windmill" in Inter beside the mark. A night mark. Hairlines and one ground in place of card
outlines, shadows and a ground per room. A first screen with no live scene. Brand foundations still
describe the pages as built; the [ledger](consistency.md#marketing-and-email) holds the difference until
the flow is marked Ready for dev.

**The drawings** are 🧪 proposal boards on the Marketing file's page
[Site redesign · 2026-11-21](https://www.figma.com/design/uWLMdVmzTcobOh8hbeem81?node-id=260-2508).

## Owner rulings and open decisions

Ruled:

- The AI guides and the person does the work. No string says the AI "works for you" or "does it for
  you".
- The front page's main heading: "Windmill is where a person keeps growing in body, skill and mind."
  Under it: "An AI-native training log, skill tree and journal." and "The AI guides. The work stays
  yours. Use your own AI or ours."
- The feature that leads each room: Roadmap, "Tell an AI your goal, get a skill tree."; Journal, "Your
  own words, echoed back."; Gym, "A coach that has read every set."
- The front page's order: the heading and its two lines, the strip of three, a section per room in the
  order Roadmap, Journal, Gym, "Your AI, or ours.", where it runs, the footer.
- The appearance switch has three positions: Auto, Light, Dark.
- Windmill One on the front page is a plain statement that it is not on sale yet, with a link to pricing
  and no price number.
- `/about` has no section on who makes Windmill.
- `/pricing` states where the $12 goes, in dollars.
- The look is Instrument, and a first visit follows the visitor's device.
- The header carries the mark with the word "Windmill" in Inter.

Open:

- Approval of the front page, which is being redrawn with the wording above.
- Approval of the night version of the mark.

## Order of work

1. Correct the false strings. They do not wait for the design.
2. Search repairs that change no layout: structured data, the tree page's first HTML and its 404,
   one description per page, short addresses.
3. The designer redraws the front page in the Instrument look with the ruled wording: the first
   screen names the three tools and each room leads with one feature. The owner reviews it and the
   night mark.
4. After that approval the designer draws the other pages, and the owner marks the flow.
5. Build from the marked flow, with the landings rendered at build time. Brand foundations' Fonts, Logo
   and Landings sections are updated when the flow is marked Ready for dev.
