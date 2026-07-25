import React from 'react';
import { SHARE_PALETTE } from './palette.js';
import { treePortraitSvg } from './TreePortrait.js';

// The gallery thumb (X2 spec #12) — one tree, drawn the same way on every surface that
// exhibits trees: the design showcase, and the in-product wall at #/browse. Drops the
// postcard mat — it already lives inside app chrome — but keeps the kind rule and reuses
// the share frame's title + progress readout. All color comes from SHARE_PALETTE[theme];
// the surface and text branch on theme so a dark card is a dark card, not a light one dimmed.
//
// Three slots vary by surface. The thumb is either a live RenderModel (`model`) or the
// tree's own uploaded portrait (`portrait`, a URL). The footer is either the showcase's
// byline (`author`) or whatever the surface composes (`children`). And `loading` draws the
// whole anatomy as neutral blocks — thumb, kind rule, title line, meta line, footer — at
// the card's exact height, so the card that replaces it lands with no shift (X3 §4).
//
// A surface that uses `loading`, `href` or `badge` mounts GALLERY_CARD_CSS once.

// The three body rows carry fixed heights so a skeleton and a filled card can never
// disagree about how tall the card is — the same code draws both.
const TITLE_LINE = 22;
const META_LINE = 16;
const FOOTER_LINE = 28;

export function GalleryCard({
  title, stats, dominantKind, model, portrait, theme = 'light', author, updatedAgo,
  href, badge, loading = false, width = 288, className = '', children,
}) {
  const pal = SHARE_PALETTE[theme];
  const hue = pal.kinds[dominantKind] ?? pal.kinds.terracotta;
  const isDark = theme === 'dark';

  const surface = isDark ? pal.mat : 'var(--surface-card)';
  const border = isDark ? pal.edge : 'var(--border-subtle)';
  const shadow = isDark ? pal.shadow : 'var(--shadow-sm)';
  const textPrimary = isDark ? pal.text : 'var(--text-primary)';
  const textSecondary = isDark ? pal.sub : 'var(--text-secondary)';
  const textTertiary = isDark ? pal.tert : 'var(--text-tertiary)';

  // A pixel-wide card sizes its thumb in pixels (~16:9, 158 at the 288 default); a fluid
  // one takes the OG portrait's own shape, the same box the public wall gives it.
  const thumbHeight = typeof width === 'number' ? Math.round(width * 0.55) : null;
  const thumbBox = thumbHeight === null ? { aspectRatio: '1200 / 630' } : { height: thumbHeight };

  // A skeleton's kind rule is neutral: a coloured skeleton promises a tree that may not arrive.
  const rule = loading ? 'var(--neutral-200)' : hue.c;

  return (
    <div
      className={`wm-gc ${className}`.trim()}
      style={{
        position: 'relative', width, background: surface, border: `1px solid ${border}`,
        borderRadius: 'var(--radius-xl)', overflow: 'hidden', boxShadow: shadow,
      }}
    >
      <div style={{ position: 'relative', ...thumbBox, background: loading ? 'transparent' : pal.panel, borderBottom: `1px solid ${border}`, overflow: 'hidden' }}>
        {loading && <span className="wm-gc-block" style={{ position: 'absolute', inset: 0, borderRadius: 0 }} />}
        {!loading && model && thumbHeight !== null && (
          <div style={{ position: 'absolute', inset: 0 }} dangerouslySetInnerHTML={{ __html: treePortraitSvg(model, pal, { w: width, h: thumbHeight }) }} />
        )}
        {!loading && portrait && (
          <img className="wm-gc-shot" src={portrait} alt="" loading="lazy" width="1200" height="630" />
        )}
        <div style={{ position: 'absolute', left: 0, top: 0, right: 0, height: 4, background: rule }} />
        {badge && !loading && (
          <span className="wm-gc-badge" style={{ background: surface, border: `1px solid ${border}`, color: textSecondary }}>{badge}</span>
        )}
      </div>

      <div style={{ padding: '13px 15px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: TITLE_LINE }}>
          <span style={{ width: 9, height: 9, borderRadius: '999px', background: rule, boxShadow: loading ? 'none' : `0 0 6px rgba(${hue.rgb},.55)`, flexShrink: 0 }} />
          {loading ? (
            <span className="wm-gc-block" style={{ height: 13, width: '62%' }} />
          ) : (
            <TitleLine href={href} color={textPrimary}>{title}</TitleLine>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 11, height: META_LINE }}>
          {loading ? (
            <span className="wm-gc-block" style={{ height: 10, width: '100%' }} />
          ) : (
            <>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, color: textSecondary, flexShrink: 0 }}>
                {stats.done}/{stats.total}
              </span>
              <div style={{ flex: 1, height: 6, borderRadius: '999px', background: pal.track, overflow: 'hidden' }}>
                <div style={{ width: `${stats.percent}%`, height: '100%', borderRadius: '999px', background: `linear-gradient(90deg, ${pal.gradA}, ${pal.gradB})` }} />
              </div>
              <span style={{ fontSize: 10.5, fontWeight: 600, color: textSecondary, flexShrink: 0 }}>{stats.percent}%</span>
            </>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, paddingTop: 11, height: FOOTER_LINE, borderTop: `1px solid ${border}` }}>
          {loading && <span className="wm-gc-block" style={{ height: 10, width: '45%' }} />}
          {!loading && author && (
            <>
              <span style={{ width: 20, height: 20, borderRadius: '999px', background: hue.soft, color: textPrimary, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10, flexShrink: 0 }}>
                {author.trim()[0].toUpperCase()}
              </span>
              <span style={{ fontSize: 11, fontWeight: 600, color: textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {author}
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 10, color: textTertiary, flexShrink: 0 }}>updated {updatedAgo}</span>
            </>
          )}
          {!loading && !author && children}
        </div>
      </div>
    </div>
  );
}

// The title is the card's one link when it has a destination: its ::after stretches over
// the whole card, so clicking anywhere opens the tree while a real button in the footer
// (fork) still takes its own clicks — no interactive element nested inside another.
function TitleLine({ href, color, children }) {
  const style = {
    fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16.5, color,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  };
  if (!href) return <span style={style}>{children}</span>;
  return <a className="wm-gc-open" href={href} style={style}>{children}</a>;
}

// Mounted once by any surface that draws linked, badged or loading cards. The neutral
// sweep is the card's whole loading vocabulary (X3): neutral-100 ↔ neutral-200, 2s linear,
// never a kind hue; reduced motion holds it at a flat neutral-100.
export const GALLERY_CARD_CSS = `
  .wm-gc-shot { display:block; width:100%; height:100%; object-fit:cover; }
  .wm-gc-open { text-decoration:none; }
  .wm-gc-open::after { content:''; position:absolute; inset:0; }
  .wm-gc-badge { position:absolute; right:8px; bottom:8px; padding:3px 9px; border-radius:var(--radius-full);
                 font-family:var(--font-body); font-size:10px; font-weight:800; white-space:nowrap; }
  .wm-gc-block { display:block; border-radius:var(--radius-sm);
                 background:linear-gradient(90deg, var(--neutral-100) 0%, var(--neutral-200) 50%, var(--neutral-100) 100%);
                 background-size:200% 100%; animation:wm-gc-sweep 2s linear infinite; }
  @keyframes wm-gc-sweep { from { background-position:100% 0; } to { background-position:-100% 0; } }
  @media (prefers-reduced-motion: reduce) {
    .wm-gc-block { background:var(--neutral-100); animation:none; }
  }
`;
