# SEO — current state and open items

Domain: `https://windmill.works`.

## What the origin answers

- The brand root and the three product landings (`/roadmap`, `/journal`, `/gym`) are static shells,
  each with its own head and no-JS fallback body, built by `scripts/build-landing-shells.mjs` from
  `src/shell/marketing/landingHeads.js` plus each product's `marketing/landingHead.js`.
- The shelf pages (`pricing`, `connect`, `changelog`, `privacy`, `terms`, `refunds`, `gallery`) are
  static files in `public/`, each carrying its own title, description, canonical and full
  OG/Twitter set.
- `/gallery` and `/t/:id` are server-served: Caddy routes them to the backend, which splices each
  tree's own unfurl meta into the built shell. A tree its owner never listed is `noindex` on its own
  page and appears on no wall.
- Unknown paths answer a real **404** (`public/404.html`, `noindex, follow`, served with
  `status 404`). `try_files` names the SPA's only non-file pathname explicitly and ends without a
  catch-all, which is what keeps it from being a soft 404.
- Extensionless twins 301 to the URL each page's own canonical names (`/pricing` → `/pricing.html`,
  `/gallery.html` → `/gallery`). `/products/<name>` URLs 301 to `/<name>`.
- The API host carries `X-Robots-Tag: noindex` and serves its own `robots.txt` disallowing all.
- `sitemap.xml` is generated at build from each page's own `<link rel="canonical">`, skipping
  anything whose robots meta says `noindex`. No `lastmod`: nothing in the build knows a page's true
  edit date.

## Build gates

`scripts/staticPageAssets.js` asserts that every `og:*`/`twitter:*` tag equals the head above it and
that any indexable page names a canonical. `build-landing-shells.mjs` fails if a landing head names
a module that is not in the Vite manifest, or if a row has no fallback body. Drift is a build
failure, not a review item.

`landingHeads.js` and everything it reaches must stay pure data resolvable by plain Node — no
top-level `.jsx` import, no browser global — or the build can no longer see the landings.

## Not in this repo: the AI half of robots.txt

Cloudflare's managed robots.txt is switched on for the zone and prepends its own block to
`public/robots.txt`: `Content-Signal: search=yes,ai-train=no,use=reference`, then `Disallow: /` for
ClaudeBot, GPTBot, Google-Extended, CCBot, Bytespider, Amazonbot, Applebot-Extended and
meta-externalagent. Change it in the Cloudflare dashboard (AI Crawl Control), not here. Fetch the
live URL before concluding what the site allows.

## Open items

- **Hash routes cannot be indexed.** `#/app`, `#/showcase`, `#/connect` are URL fragments — never
  sent to the server — so they collapse to the root card. Indexing them needs History API path
  routing plus per-path prerender, keeping the app editor on hash/noindex.
- **One `og-image.png` for the whole family.** Every product landing unfurls the same card.
- **No `sameAs` on the Organization** — no accounts exist to name.
- **`/t/:id` pages are reachable only through the gallery wall.** A generated sitemap of public
  trees is worth building when that wall fills.
- **No per-quest landing pages** (dev paths, a roadmap.sh comparison, use-case pages) — the largest
  untapped demand.
- **`Button` is not polymorphic.** It renders a `<button>` and takes no `href`, so landing CTAs wrap
  it in an `<a>`: invalid HTML and a duplicate tab stop.
- **No font preload** for Baloo 2 700 / Nunito 400 woff2.
- **The landing is not prerendered.** The static `#root` fallback covers crawlers; SSG would make
  the full hydrated copy indexable, and needs the WebGL scenes behind a client-only boundary.
