import React from 'react';
import { SHARE_PALETTE } from './palette.js';
import { treePortraitSvg } from './TreePortrait.js';

// The in-product gallery thumb (X2 spec #12). Drops the postcard mat — it already
// lives inside app chrome — but keeps the kind rule and reuses the share frame's
// title + progress readout. All color comes from SHARE_PALETTE[theme]; the surface
// and text branch on theme so a dark card is a dark card, not a light one dimmed.
export function GalleryCard({ title, stats, dominantKind, model, theme = 'light', author, updatedAgo, width = 288 }) {
  const pal = SHARE_PALETTE[theme];
  const hue = pal.kinds[dominantKind] ?? pal.kinds.terracotta;
  const isDark = theme === 'dark';

  const surface = isDark ? pal.mat : 'var(--surface-card)';
  const border = isDark ? pal.edge : 'var(--border-subtle)';
  const shadow = isDark ? pal.shadow : 'var(--shadow-sm)';
  const textPrimary = isDark ? pal.text : 'var(--text-primary)';
  const textSecondary = isDark ? pal.sub : 'var(--text-secondary)';
  const textTertiary = isDark ? pal.tert : 'var(--text-tertiary)';

  const thumbH = Math.round(width * 0.55); // ~16:9, 158 at the 288 default
  const initial = author ? author.trim()[0].toUpperCase() : '?';

  return (
    <div style={{ width, background: surface, border: `1px solid ${border}`, borderRadius: 'var(--radius-xl)', overflow: 'hidden', boxShadow: shadow }}>
      <div style={{ position: 'relative', height: thumbH, background: pal.panel, borderBottom: `1px solid ${border}`, overflow: 'hidden' }}>
        {model && (
          <div style={{ position: 'absolute', inset: 0 }} dangerouslySetInnerHTML={{ __html: treePortraitSvg(model, pal, { w: width, h: thumbH }) }} />
        )}
        <div style={{ position: 'absolute', left: 0, top: 0, right: 0, height: 4, background: hue.c }} />
      </div>

      <div style={{ padding: '13px 15px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 9, height: 9, borderRadius: '999px', background: hue.c, boxShadow: `0 0 6px rgba(${hue.rgb},.55)`, flexShrink: 0 }} />
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16.5, color: textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 11 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, color: textSecondary, flexShrink: 0 }}>
            {stats.done}/{stats.total}
          </span>
          <div style={{ flex: 1, height: 6, borderRadius: '999px', background: pal.track, overflow: 'hidden' }}>
            <div style={{ width: `${stats.percent}%`, height: '100%', borderRadius: '999px', background: `linear-gradient(90deg, ${pal.gradA}, ${pal.gradB})` }} />
          </div>
          <span style={{ fontSize: 10.5, fontWeight: 600, color: textSecondary, flexShrink: 0 }}>{stats.percent}%</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, paddingTop: 11, borderTop: `1px solid ${border}` }}>
          <span style={{ width: 20, height: 20, borderRadius: '999px', background: hue.soft, color: textPrimary, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10, flexShrink: 0 }}>
            {initial}
          </span>
          <span style={{ fontSize: 11, fontWeight: 600, color: textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {author}
          </span>
          <span style={{ marginLeft: 'auto', fontSize: 10, color: textTertiary, flexShrink: 0 }}>updated {updatedAgo}</span>
        </div>
      </div>
    </div>
  );
}
