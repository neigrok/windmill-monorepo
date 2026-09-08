# Roadmap link previews and gallery portraits

Sharing provides the public roadmap URL (`windmill.works/t/<id>`). It does not generate or upload
an image or video. The publish-and-copy contract lives in `sharing.md`.

## Link previews

`SharePageApi` points `og:image` at `/og/<id>.png`. `OgImageApi` serves an existing stored asset
when available; otherwise it redirects to `/og-image.png`, the generic fallback. Neither opening
Share nor publishing refreshes that asset. A stored image can be stale, and a new public roadmap
can have a generic preview. Do not promise a fresh per-tree image, progress snapshot, exact crop,
or matching appearance between a social preview and the live roadmap.

There is no client PNG capture, OG upload, video render, or user-facing image export control.
Preview failure must not block publishing or copying a confirmed public link.

## Gallery portraits

In-product gallery cards may render a live SVG portrait from their loaded tree model. That
portrait must use the tree's own canvas positions and current model progress, with the roadmap's
kind and tier treatments. Fit its bounds into the card without re-layout; preserve a legible
minimum scale for small trees. This SVG is display content, not a downloadable sharing artifact.

The server-rendered `/gallery` uses `/og/<id>.png`, so it can show a stored image or the generic
fallback. Do not describe both gallery surfaces as guaranteed fresh per-tree renders. The shared
card anatomy remains kind rule, title, progress and recency; portrait delivery differs by surface.
