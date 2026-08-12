# Windmill — SEO Audit & Implementation

_Audited 2026-07-12. Domain: `https://windmill.works`. Method: 7 parallel specialist audits of the live codebase (head/meta, crawlability, structured data, content/keywords, social, Core Web Vitals, semantic/a11y), reconciled into one plan. 47 findings._

> **Read as a record of that day, not of today (checked 2026-08-05).** Its file paths are
> pre-monorepo (`src/App.jsx`, `src/marketing/Marketing.jsx` — the second no longer exists,
> `934a241`), and most of what it lists below as *not done* has since shipped:
> `public/og-image.png` (1200×630), `apple-touch-icon.png`, `favicon.ico`, `icon-192.png` /
> `icon-512.png`, and real `privacy.html` / `terms.html` / `changelog.html` pages (follow-ups
> 1 and 2); per-path landings for `/roadmap`, `/journal` and `/gym`, each built as its own
> static shell with its own head and no-JS body by `scripts/build-landing-shells.mjs`
> (follow-up 5, in part). The architectural ceiling closed too: `/t/:id` and `/gallery` are
> now real server-served paths — Caddy routes them to the backend, which splices each tree's
> own unfurl meta into the built shell — so a shared tree does get its own card, and
> `sitemap.xml` lists eleven URLs where it once listed the root alone. Follow-ups 3, 4 and
> the SSG half of 5 are still open.
>
> **A second pass ran 2026-08-12** — crawl integrity rather than on-page copy. Its record is
> the last section of this file, and it is the one to read first: it is what the site does now.

## Executive summary

Windmill is a client-rendered React/Vite **SPA with hash routing**, so to any crawler there is exactly **one fetchable URL** — the root landing. That single page shipped with essentially **no SEO surface**: the `<title>` still said "Design System", there were no Open Graph/Twitter cards, no canonical, no structured data, no `robots.txt`/`sitemap.xml`, no favicon/manifest, and an empty `#root` (crawlers and social scrapers saw a blank body behind the wrong title).

The highest-leverage fixes were cheap and are now **done**: correct the static `<head>`, make it product-facing, add social + structured data, ship crawl files, and give crawlers real body content by (a) eager-loading the landing and (b) writing a static hero fallback into `#root`. Estimated on-page SEO: **~22/100 → ~82/100** after this pass. The remaining ceiling is the hash-routing architecture (below) plus the assets that need image tooling to generate.

## What shipped (this pass)

| Area | Change | Files |
|---|---|---|
| **Title/description** | Product- + keyword-facing SERP title and description | `index.html` |
| **Indexing** | Self-referencing `canonical`, `robots: index,follow,max-image-preview:large` | `index.html` |
| **Social** | Full Open Graph + Twitter `summary_large_image` (product voice) | `index.html` |
| **Structured data** | Static JSON-LD `@graph`: WebSite · Organization · SoftwareApplication (free offer) · FAQPage (6 Q&A) | `index.html` |
| **App identity** | `color-scheme`, `application-name`, `author`, `format-detection`, `theme-color` | `index.html` |
| **Icons/manifest** | `favicon.svg` (on-brand skill-tree mark) + `site.webmanifest` | `public/`, `index.html` |
| **Crawl files** | `robots.txt` (allows `/assets/`, points at sitemap) + `sitemap.xml` (root only) | `public/` |
| **Crawlability** | Static hero fallback in `#root` (H1, tagline, CTAs, path names) — mirrors rendered copy, replaced by React on mount | `index.html` |
| **LCP** | Landing route made **eager** (was `React.lazy`) so it paints in one download | `src/App.jsx` |
| **CLS** | Reserve exact hero height in CSS so the band doesn't collapse from 0 before JS mounts | `src/marketing/marketing.css` |
| **INP** | Defer the WebGL hero mount via `requestIdleCallback` | `src/marketing/Marketing.jsx` |
| **A11y/semantics** | `<main>` + skip link; `beatTitle` → `h3` + Story `h2` (valid heading outline); `aria-hidden` on decorative WebGL mounts & inline SVG icons; injected "Fork" link removed from tab order | `Marketing.jsx`, `marketing.css`, `treeScenes.js` |
| **Viewport** | Dropped `maximum-scale=1, user-scalable=no` (WCAG 1.4.4) | `index.html` |

Verified: `vite build` passes; `dist/{robots.txt,sitemap.xml,site.webmanifest,favicon.svg}` serve with correct content-types; JSON-LD parses; H1 is present in the raw HTML response.

## Findings by dimension

**P0 (shipped)** — wrong `<title>` (indexed under "design system"); empty `#root` / no prerendered body; zero Open Graph/Twitter (the share loop — "every tree is a page you can fork" — had zero visual pull).

**P1 (shipped)** — off-topic meta description; missing canonical (`?view=` query variants serve identical HTML → duplicate risk); no `robots.txt`/`sitemap.xml`; no JSON-LD; hero CLS (0→~half-viewport jump); LCP behind two lazy JS chunks; no `<main>` landmark; broken heading outline; zoom-disabling viewport.

**P2 (shipped/partial)** — no favicon/manifest (shipped SVG + manifest; PNGs pending, below); keyword-free H2s; decorative WebGL trees not hidden from screen readers (shipped `aria-hidden`); INP cost of synchronous hero mount (shipped defer).

**P3 (noted)** — no `application-name`/`author`/`format-detection` (shipped); per-tree shares can't get their own unfurl under hash routing (architectural, below).

## Keyword strategy

- **Recommended `<title>`** (shipped that day, 54 chars): `Windmill — Skill Tree Goal Tracker & Learning Roadmaps`. **Superseded**: Windmill became three
  products on one account, and the root now reads `Windmill — Roadmap, Journal & Gym for self-growth`
  (`src/shell/marketing/landingHeads.js`), with the skill-tree terms carried by `/roadmap`'s own
  title. The keyword list below is still the roadmap product's, not the brand's.
- **`og:`/`twitter:` title** (brand voice, for share CTR): `Windmill — Any goal, as a skill tree`
- **Primary head terms:** goal tracker app · learning roadmap app · skill tree goal tracker · gamified productivity · roadmap app · visual goal planner
- **Secondary:** RPG skill tree app · roadmap.sh alternative · shareable/forkable roadmap · developer learning path tracker · MCP/agent-native roadmap
- **Long-tail:** "turn goals into a skill tree" · "frontend/rust/ML roadmap tracker" · "roadmap.sh alternative that tracks progress" · "let Claude build my roadmap" · "life goals skill tree app free"
- **Ranking angles:** (1) intercept roadmap.sh dev-path demand with progress-tracking living pages (Windmill legitimately adapts the CC BY-SA maps); (2) "skill tree" × real-life goals is a distinctive, thin niche; (3) MCP/agent-native is near-zero competition — early-mover.

## Follow-ups (not done — need assets, product decisions, or larger scope)

1. **Add the PNG assets** (no image tooling in-repo to generate them). The tags reference these paths; add the files to `public/` and they resolve:
   - `public/og-image.png` — **1200×630**, cream `#F9F5EB` bg, RPG skill-tree with terracotta/gold/sky nodes (one "unlocked"), "Windmill" wordmark + tagline, text within a 1080×510 safe area. **Ship this before promoting links** so scrapers don't cache the 404.
   - `public/apple-touch-icon.png` (180×180), `public/favicon.ico` (32×32), and PNG manifest icons (192/512) — then re-add their `<link>`/manifest entries.
2. **Real destinations for placeholder links** — Nav "Changelog" and footer Privacy/Terms/Twitter are still `href="#"` (crawl-signal noise + E-E-A-T gap). Needs real pages / an X handle — a product/legal decision, not invented here.
3. **Make `Button` polymorphic** (`href` → render `<a>`) so CTAs stop nesting `<button>` inside `<a>` (invalid HTML, duplicate tab stops). Touches a shared component used app-wide — deferred out of this SEO pass.
4. **Font preload** — preload Baloo 2 700 + Nunito 400 woff2 (copy to `public/fonts/` for stable, un-fingerprinted URLs, or inject via a Vite `transformIndexHtml` hook). Skipped here to avoid a double-download/@font-face regression.
5. **Per-path landing pages** (highest untapped demand): one crawlable page each for the dev paths (Frontend/Rust/ML/Ship v1.0 + the other 5 quests), a "roadmap.sh alternative" comparison page, use-case pages (bake/10k/room/side-project), and an MCP/"build with Claude" page.
6. **Prerender/SSG the landing** (`vite-react-ssg`, single route) — wrap the WebGL scenes in a client-only boundary. The static `#root` fallback covers the immediate need; this makes the full hydrated copy indexable.

## Second pass — 2026-08-12: crawl integrity

_The first pass fixed what the root page **said**. This one fixed what the origin **answered** —
found by probing the live site rather than reading the tree, which is why none of it appears above._

| Finding | What was true | Fix | Files |
|---|---|---|---|
| **Soft 404 on every unknown path** (P0) | `try_files … /index.html` meant `/typo`, `/email/logo.png`, `/wp-admin` — anything — answered **200 with the brand root's page**. Infinite URLs, each a copy of the homepage; Google either indexes them or burns the crawl budget deciding not to. Measured live: `/nope-404` → `200 text/html`. | The SPA's only non-file pathname (`/app`, `/app/*` — App.jsx's `ownRoute`) is named explicitly, so `try_files` needs no catch-all; unknown paths raise a real 404, dressed by `handle_errors` in `public/404.html` (`noindex, follow`, links to the whole house) with `file_server { status 404 }`. | `backend/deploy/Caddyfile`, `web/public/404.html` |
| **Second indexable hostname** (P1) | `$DOMAIN_API` proxies the same backend, so `api.windmill.works/gallery` served the wall in full and `/robots.txt` there **404'd** — which a crawler reads as "crawl everything". Canonicals point home, so the duplicate collapses, but only after a whole second site is crawled. | `X-Robots-Tag: noindex` on that host, and a `robots.txt` of its own that disallows all. | `backend/deploy/Caddyfile` |
| **Two URLs per shelf page** (P2) | `/pricing` (no extension) and `/gallery.html` both answered 200 — the extensionless twin with the *homepage's* body, the other with the empty gallery template. | 301 → the URL each page's own canonical names. | `backend/deploy/Caddyfile` |
| **Shelf pages unfurled bare** (P1) | Pricing, Connect, Changelog, Privacy, Terms, Refunds carried **no Open Graph or Twitter tags at all** — pasted into Slack or a DM they arrived as a naked URL. Connect is the MCP acquisition page. | Full OG/Twitter on all six + the gallery's missing half, each repeating that page's own title/description/canonical. Drift is a build failure now: `staticPageAssets.js` asserts `og:*`/`twitter:*` equal the head above them, and that any indexable page names a canonical. | `web/public/*.html`, `web/scripts/staticPageAssets.js` |
| **A hand-kept sitemap** (P2) | `public/sitemap.xml` was written by hand and had drifted: `/gym` dated a week before gym opened, plus `priority`/`changefreq` values nobody had revisited (and Google ignores). | Deleted. The build now emits it from **each page's own `<link rel="canonical">`**, skipping anything whose own robots meta says `noindex` — so a new page is listed the moment it exists. No `lastmod`: nothing in the build knows a page's true edit date (CI checks out shallow), and a date we cannot stand behind is worse than none. | `web/scripts/build-landing-shells.mjs` |

**Verified, not assumed.** The Caddyfile was adapted and run in a container against a copy of
`dist/` (`caddy validate`, then live probes): `/` `/roadmap` `/gym/` `/pricing.html` → 200;
`/pricing` `/connect` → 301 to `.html`; `/gallery.html` → 301 to `/gallery`; `/app` `/app/settings`
→ 200 (the shell); `/nope-404` and `/email/logo.png` → **404** carrying `Page not found — Windmill`;
the API host's `/robots.txt` → 200 `Disallow: /` with `X-Robots-Tag: noindex`. `npm run build`
(suite + shells + sitemap) is green.

**Deploy note:** the Caddyfile ships with `deploy.yml`, which a green `backend.yml` triggers — so
the origin half lands on the next backend deploy, and the `dist/` half on the next web deploy.

**Still open after this pass:** every product landing still unfurls the roadmap's share card
(one `og-image.png` for the family — art, not copy); no `sameAs` on the Organization (no social
accounts to name); `/t/:id` pages are discoverable only through the gallery wall, which today
holds one card — a generated sitemap of public trees is worth building when that wall fills.

## Architectural ceiling: hash routing

`#/app`, `#/t/:id`, `#/showcase` are URL **fragments** — never sent to the server, stripped by search engines — so they can never be indexed or get their own social unfurl; all collapse to the root card. The `?view=` variant is server-visible but serves identical HTML, so it's not usefully distinct without SSR. To index shared trees / the showcase, migrate those to **History API path routing** (`/t/:id`, `/showcase`) with an SPA server fallback + per-path prerender, keeping the app editor on hash/noindex. Out of scope for this landing pass — noted so per-tree indexing isn't assumed to work.
