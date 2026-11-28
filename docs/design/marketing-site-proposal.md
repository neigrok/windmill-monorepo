# Marketing site

The public pages of windmill.works: the sitemap, the Instrument look, what is built, what
is proposed, how search engines read the pages, and the strings still false. The drawings
are on the Marketing file's page [Site redesign · 2026-11-21](https://www.figma.com/design/uWLMdVmzTcobOh8hbeem81?node-id=260-2508).
A page is built only from its section marked ✅ Ready for dev. Its wording is on that section's boards;
each page's title, which the boards do not draw, is recorded here.

The pages speak from [the idea](communication.md#the-idea) and keep every rule in the
[communication guide](communication.md) and in [Honesty](brand-foundations.md#honesty).

## What the pages are for

A visitor should learn four things, in this order, and each page owns one of them.

1. What Windmill is, what its three tools are and the one feature that leads each: the front page.
2. What one room does for one job: a page per room.
3. That the AI is theirs to choose: the page about using your own assistant.
4. How Windmill is paid for: the pricing page.

## Sitemap

| Address | Its one job | State |
|---|---|---|
| `/` | Say what Windmill is, name its three tools with the feature that leads each, and send the visitor to a room | Built in the Instrument look |
| `/roadmap` | Any goal as a skill tree | Built in the Instrument look |
| `/journal` | A daily journal you can search by meaning | Built in the Instrument look |
| `/gym` | A workout log that remembers what you lifted | Built in the Instrument look |
| `/pricing` | What is free, what One is, where the money goes | Built in the Instrument look, as `/pricing.html` |
| `/support` | Where to write, how to keep or remove your data, where a subscription is managed | Exists as `/support.html`, in the family look |
| `/connect` | Use the assistant you already have | Exists as `/connect.html`; linked from the front page and the footers |
| `/about` | Why Windmill exists, what the name means, what it will not do | Proposed; no page and no link |
| `/changelog` | What changed, with real dates | Exists as `/changelog.html`; Roadmap only, every entry July 2026 |
| `/gallery` | Roadmaps their owners listed in public | Exists |
| `/t/<id>` | One published roadmap, readable before any script runs | Exists; its no-script body and structured data are the front page's |
| `/privacy`, `/terms`, `/refunds` | Legal | Exist as `.html` |

- A page for guides is added only when the first real guide exists. A page without a useful artifact
  of its own stays unpublished.
- The static pages send "Start your tree" to `/#/app`; the front page's pill "Open Windmill" goes to
  `/app` signed out and to the last room signed in.

## The Instrument look

Every rebuilt public page wears it. Its tokens are `web/src/styles/tokens/looks.css`, read through the
page frame's `data-look="instrument"`.

- Inter for all page type, self-hosted and fetched by these pages only, with few sizes and tight
  display type ([Fonts](brand-foundations.md#fonts)).
- One ground per page: warm paper by day, near-black by night. Day, night and Auto; a first visit
  follows the device, and the footer's switch has the three positions.
- Hairlines in place of shadows and card outlines. Terracotta is the one accent, and a room's hue
  appears only inside its own picture.
- The header carries the approved mark, unchanged, with the word "Windmill" set in the page's type;
  on a night ground it carries the night mark, the same shapes with a lighter hub and door
  ([Logo](brand-foundations.md#logo)).
- Product pictures are compositions of the product's own components, tokens and type, each labelled
  as composed. A picture rests still. Under the pointer it answers with its room's own feedback and
  runs at most its room's one loop while the pointer stays; a picture that has a beat plays it when the
  pointer arrives, and on a phone plays it once, as it comes into view. Nothing in it navigates, takes
  focus or changes what it shows
  ([Motion language §8](guidelines/motion-language.md#8-pictures-on-public-pages)).
- Controls are small and quiet, and the footer is the sitemap.

## Built: the front page `/`

Drawn in section [C · Front page](https://www.figma.com/design/uWLMdVmzTcobOh8hbeem81?node-id=272-2508) and
built in `web/src/shell/marketing/BrandLanding.jsx` with `brandLanding.css`. Its words live in
`web/src/shell/i18n/entry/en.json` (`shell.landingHead.*`, `shell.brandLanding.*`, `shell.site.*`)
and, for each room's row and section, in that product's `web/src/products/<product>/i18n/entry/en.json`
under `<product>.root.*`, which the product's `routes.js` hands the page as `landing.root`. Each room's
picture is its `marketing/RootPicture.jsx`. The head and the no-script body are
`web/src/shell/marketing/landingHeads.js`, copied into `web/index.html`. Its events are in
[web/OBSERVABILITY.md](../../web/OBSERVABILITY.md#front-page-product-landings-and-the-pricing-page).

| Part | Wording |
|---|---|
| Title | Windmill — a skill tree, a workout log and a journal |
| Description | Windmill is where a person keeps growing in body, skill and mind. An AI-native workout log, skill tree and journal. Use your own AI or ours. |
| Main heading | Windmill is where a person keeps growing in body, skill and mind. |
| Under it | An AI-native workout log, skill tree and journal. · The AI guides. The work stays yours. Use your own AI or ours. |

The page runs in this order:

1. **Header.** The mark and the word "Windmill"; Roadmap, Gym, Journal, Pricing; Sign in, or the
   account seat signed in; the pill "Open Windmill".
2. **The first screen.** The heading and the two lines under it.
3. **The three tools**, a row per open room with its full name, what it is ("skill-tree planner",
   "daily journal", "workout log"), its line and a link: Start a tree · Write tonight · Open the log.
4. **A section per open room**, Roadmap, Journal, Gym: a two-line heading, one paragraph and its
   link, the composed picture ("Composed tree", "Composed page", "Composed session") and three named
   features.
5. **Your AI, or ours.** Yours → How to connect. Ours: built in, and a free account includes some each
   month; "Windmill One raises the ceiling for one price. It is not on sale yet." → See pricing.
6. **Where it runs.** "Web: Roadmap, Gym and Journal. The phone apps are in beta and not public yet."
7. **Footer.** Rooms (Roadmap, Gym, Journal) · Your own assistant (Connect) · Windmill (Pricing,
   Changelog, Gallery, Support) · Legal (Privacy, Terms, Refunds); then Feedback and Auto · Light · Dark.

A room that holds itself shut brings no row and no section, and keeps its place in the header and
footer.

## Built: the room pages, pricing and support

The three room pages and the pricing page are drawn on their sections of the same Figma page and share
the front page's header and footer (`web/src/shell/marketing/SiteChrome.jsx`, `site.css`). Their
events are in [web/OBSERVABILITY.md](../../web/OBSERVABILITY.md#front-page-product-landings-and-the-pricing-page).

A room page is plain page data, `web/src/products/<product>/marketing/landingPage.js`, in the words of
`web/src/products/<product>/i18n/landing/en.json`, drawn by `web/src/shell/marketing/ProductLanding.jsx`.
Its pictures are `marketing/LandingPictures.jsx`, composed from the room's own components and labelled.
The build writes the same page data into the first HTML (`web/scripts/productLandingBody.mjs`), and a
browser test holds the first HTML and the running page alike. If the page's code fails to load, the
first HTML stays on screen.

### Windmill Roadmap `/roadmap`

[C · Roadmap page](https://www.figma.com/design/uWLMdVmzTcobOh8hbeem81?node-id=290-2508). Title "Skill
Tree Maker for Real-Life Goals | Windmill Roadmap". Main heading "A skill tree for real-life goals".
Sections: Tell an AI your goal. Get a skill tree. · What comes first, and what opens next · Three ways
to start a tree · One step at a time · Publish a tree, or keep it · No account to begin · What it will
not do · What stays in your browser, and what does not · Where it runs · seven questions · "Plant your
first tree." Windmill One does not appear on it.

### Windmill Journal `/journal`

[C · Journal page](https://www.figma.com/design/uWLMdVmzTcobOh8hbeem81?node-id=294-2508). Title "Journal
App With Search by Meaning | Windmill Journal". Main heading "A daily journal you can search by
meaning". Sections: Your own words, echoed back · Find what you wrote, without the exact words · One
page a night · Look back without a score · Nothing writes back · What stays on your device, and what
does not · Yours to keep, and where it runs · seven questions · "Tonight's page is waiting." What it
says about echoes and Anthropic follows the privacy page word for meaning.

### Windmill Gym `/gym`

[C · Gym page](https://www.figma.com/design/uWLMdVmzTcobOh8hbeem81?node-id=293-2508). Title "Workout Log
for Lifters on a Program | Windmill Gym". Main heading "A workout log that remembers what you lifted".
Sections: A coach that answers from your log · Or bring your own assistant · Your target, or last
time's numbers, before every set · How to track progressive overload · For the program you already
run · What it will not do · What stays on your device, and what does not · Where it runs · eight
questions · "Bring the program you already run." Its first link opens the log, which works in a
browser with no account; Coach, notes and share links need a free account. Its structured data names
"Web browser" until an app has a public listing.

### Pricing `/pricing`

[C · Pricing](https://www.figma.com/design/uWLMdVmzTcobOh8hbeem81?node-id=284-2508). A static page,
`web/public/pricing.html`, in the look through the generated `/instrument.css`
(`web/scripts/staticInstrument.css`); a test holds its header and footer to the shared ones. Title
"Pricing — Windmill". Main heading "Windmill is free." Sections in order:

1. **Three equal columns:** by hand, free · with your own AI, free here · with Windmill's AI, $0.50
   of AI a month on a free account.
2. **Counted in dollars, at the provider's price.** The amounts: $0.25 once, signed out in the phone
   app; $0.50 each calendar month on a free account; $7 each paid month with Windmill One. Free AI also
   draws on one shared pool, named without its size.
3. **Windmill One.** $12 a month, "Not on sale yet." beside the price in plain text. Where the $12
   goes, as a bar in three parts: the AI you use, $7.00 · store and payment fees, about $1.80 ·
   Windmill, about $3.20.
4. **Questions**, a visible list that is also the page's structured data.

The split names no store: its middle part is "store and payment fees". The page promises nothing
about refunds: it says the store you buy from takes the payment and handles cancelling and refunds.
Echoes do not draw on a person's AI amount, and the page says so
([AI allowances](../../backend/AI_ALLOWANCES.md)). No other page gives a price.

### Support `/support`

`web/public/support.html`, in the family look; `/support` redirects to it. Where to write, what stays
on the device signed out, how to export and how to close an account, and where Windmill One will be
managed. The legal pages name no payment company and promise no refund: the store a person buys from
takes the payment and handles cancelling and refunds.

## Proposed, not drawn

| Page | Proposed |
|---|---|
| `/about` | Title "About Windmill — why it exists and what the name means"; main heading "Why Windmill exists". The statement from [the idea](communication.md#the-idea); The AI guides, you decide · Yours and open · Never graded · The name; what Windmill will not do; how it is paid for. No section on who makes Windmill. A founder note appears only if the owner writes one. |
| `/connect` | Title keeps "Windmill Roadmap & Gym MCP server". Main heading "Bring your own assistant". One exchange shown end to end: the request, the access asked for, the result, how to disconnect. |
| `/changelog` | Covers all three rooms. |
| `/t/<id>` | Title "<tree title> — a skill tree on Windmill Roadmap". The tree's own heading, summary and first steps are in the first HTML. |

## Strings to remove or correct

These are false, unproven or against the rules above today, whatever the design becomes. Correcting
them does not wait for the rebuild.

| Where | Says | Problem | Do |
|---|---|---|---|
| `/404` | A private tree link "now 404s" | The backend answers an unknown or private tree with the front page | Make the answer a real 404 |

## How search engines read the pages

In order of weight:

1. **The landings are whole in the first HTML.** A crawler that runs no script gets, on `/`, the
   heading, the two lines, the three tools with their links and two shelves of links; on a room
   landing, every heading, paragraph, feature, link, question and answer, and the same two shelves.
   The pictures mount over it.
2. **One visible main heading per page**, equal to what the title promises.
3. **A published tree is its own page.** Its heading, summary and first steps in the first HTML; its own
   structured data or none; an unknown or private tree answers 404. Listed trees join the sitemap with a
   last-changed date.
4. **Structured data says only what is true.** `/` carries `WebSite`, `Organization` and `WebPage`, and
   no questions. One `SoftwareApplication` per room with its real platforms and no offer until
   something is on sale. Questions only on `/pricing` and on each room page, matching the visible
   list.
5. **A social card per page**, drawn with the page: front page, each room, connect, pricing, about.
6. **Short canonical addresses**, with the `.html` address redirecting to the short one; today it is
   the other way round. One description per page.
7. **Links.** Every public page is reachable from the footer, and from the two shelves of links in
   the first HTML of `/` and of each room page.
8. **Naming.** As [the communication guide](communication.md#names) rules.
9. **Small repairs.** The `robots.txt` comment names a route that does not exist; the web manifest and
   `package.json` describe the product in two more ways.

No keyword volumes are claimed here. A title changes for a search term only after the term is checked
against real search results.
