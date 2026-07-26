# Windmill — SEO Audit & Implementation

_Audited 2026-07-12. Domain: `https://windmill.works`. Method: 7 parallel specialist audits of the live codebase (head/meta, crawlability, structured data, content/keywords, social, Core Web Vitals, semantic/a11y), reconciled into one plan. 47 findings._

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

- **Recommended `<title>`** (shipped, 54 chars): `Windmill — Skill Tree Goal Tracker & Learning Roadmaps`
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

## Architectural ceiling: hash routing

`#/app`, `#/t/:id`, `#/showcase` are URL **fragments** — never sent to the server, stripped by search engines — so they can never be indexed or get their own social unfurl; all collapse to the root card. The `?view=` variant is server-visible but serves identical HTML, so it's not usefully distinct without SSR. To index shared trees / the showcase, migrate those to **History API path routing** (`/t/:id`, `/showcase`) with an SPA server fallback + per-path prerender, keeping the app editor on hash/noindex. Out of scope for this landing pass — noted so per-tree indexing isn't assumed to work.
