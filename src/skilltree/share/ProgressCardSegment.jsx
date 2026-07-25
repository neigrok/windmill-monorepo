// The share sheet's second segment (X2 · brief #20): the week's card, the two choices that change
// it, and the doors it leaves by. The link segment above shares the TREE — its identity, its unfurl
// card, a URL that keeps working. This one shares a POST: one week of it, as a picture.
//
// It owns the settings and nothing else. The pixels come from `renderCard`, injected by the view
// that holds the model and the rasterizer, and the view memoizes the last render — so the card is
// already drawn before this opens (canon: never a spinner where the post should be) and a flipped
// setting simply asks for another one.
//
// The two settings are per tree and remembered, because both are answers about a series rather than
// about one post: whether these cards count weeks or days, and whether they carry the ledger.

import React, { useEffect, useRef, useState } from 'react';
import { Button, Switch } from '../../components';
import { ProgressPeriod, sinceLabel, WEEK_UNIT, DAY_UNIT } from './progressPeriod.js';

// `week` is what this period actually holds — { lit, sinceAt, plantedAt, ordinal, ledger } — or null
// while the tree is still loading. `onShared` advances the baseline the NEXT card is "since": asking
// for the artifact IS the share, so it fires when a door is taken, not when the preview appears. The
// segment mounts with the sheet and dies with it, which is what keeps that "once" honest.
export function ProgressCardSegment({ treeId, prefs, week, renderCard, onShared }) {
  const [unit, setUnit] = useState(() => prefs.cardUnit(treeId));
  const [ledgerOn, setLedgerOn] = useState(() => prefs.cardLedger(treeId));
  const [png, setPng] = useState(null);
  const [preview, setPreview] = useState(null);
  const [copied, setCopied] = useState(false);
  const sharedRef = useRef(false); // the baseline moves once per sheet, however many doors are used

  const count = week?.lit?.length ?? 0;
  const period = week ? new ProgressPeriod({ plantedAt: week.plantedAt, now: Date.now(), unit, ordinal: week.ordinal }) : null;
  const label = period?.label ?? '';
  const since = week ? sinceLabel({ plantedAt: week.plantedAt, at: week.sinceAt, unit }) : null;
  const ledger = ledgerOn ? (week?.ledger ?? []) : null;

  // Draw whenever the card the settings describe changes. The view's cache makes the common case —
  // opening onto a card the offer already rendered — resolve without a second raster.
  useEffect(() => {
    if (!week || count === 0) { setPng(null); return undefined; }
    let live = true;
    renderCard({ period: label, since, ledger }).then((blob) => { if (live) setPng(blob); });
    return () => { live = false; };
  }, [week, label, ledgerOn]);

  useEffect(() => {
    if (!png) { setPreview(null); return undefined; }
    const url = URL.createObjectURL(png);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [png]);

  function markShared() {
    if (sharedRef.current) return;
    sharedRef.current = true;
    onShared?.();
  }

  function chooseUnit(next) {
    setUnit(next);
    prefs.setCardUnit(treeId, next);
  }

  function chooseLedger(next) {
    setLedgerOn(next);
    prefs.setCardLedger(treeId, next);
  }

  const file = png ? new File([png], `windmill-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`, { type: 'image/png' }) : null;

  // The phone's door: the OS sheet, with the PNG attached, so a post goes straight to the app it
  // belongs in. A dismissed sheet is an answer, not a failure — nothing falls through to a download.
  async function handleOsShare() {
    markShared();
    try {
      await navigator.share({ files: [file] });
    } catch { /* dismissed or refused — the download and copy doors are still here */ }
  }

  function handleDownload() {
    markShared();
    const url = URL.createObjectURL(png);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  async function handleCopy() {
    markShared();
    try {
      await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': png })]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* the clipboard refused the image — Download is the way through */ }
  }

  const canOsShare = !!file && !!navigator.canShare?.({ files: [file] });
  const canCopy = !!png && !!navigator.clipboard?.write && typeof window.ClipboardItem === 'function';

  return (
    <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'var(--text-base)', color: 'var(--text-primary)' }}>Share the week</div>
        {count > 0 && (
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
            {label} · {count} step{count === 1 ? '' : 's'} lit{since ? ` · since ${since}` : ''}
          </div>
        )}
      </div>

      {count === 0 ? (
        <p style={{ margin: '8px 0 0', fontFamily: 'var(--font-body)', fontSize: 'var(--text-sm)', lineHeight: 1.55, color: 'var(--text-tertiary)' }}>
          Nothing new to post yet — this week’s card lights up as soon as a step does.
        </p>
      ) : (
        <>
          <div
            style={{
              marginTop: 10,
              aspectRatio: '2400 / 1260',
              borderRadius: 'var(--radius-lg)',
              border: '1px solid var(--border-subtle)',
              background: 'var(--surface-sunken)',
              overflow: 'hidden',
            }}
          >
            {preview && <img src={preview} alt={`${label} progress card`} style={{ display: 'block', width: '100%', height: '100%' }} />}
          </div>

          <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {canOsShare && <Button onClick={handleOsShare}>Share…</Button>}
            <Button variant={canOsShare ? 'secondary' : 'primary'} onClick={handleDownload} disabled={!png}>Download</Button>
            {canCopy && <Button variant="secondary" onClick={handleCopy}>{copied ? 'Copied' : 'Copy'}</Button>}
          </div>

          <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>Count this card in</div>
            <div role="group" aria-label="Count this card in weeks or days" style={{ display: 'inline-flex', padding: 2, gap: 2, borderRadius: 'var(--radius-full)', background: 'var(--surface-hover)' }}>
              {[[WEEK_UNIT, 'Weeks'], [DAY_UNIT, 'Days']].map(([value, text]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={unit === value}
                  onClick={() => chooseUnit(value)}
                  style={{
                    padding: '5px 14px',
                    border: 'none',
                    borderRadius: 'var(--radius-full)',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-body)',
                    fontSize: 'var(--text-sm)',
                    fontWeight: 700,
                    background: unit === value ? 'var(--surface-card)' : 'transparent',
                    color: unit === value ? 'var(--text-primary)' : 'var(--text-tertiary)',
                    boxShadow: unit === value ? 'var(--shadow-xs)' : 'none',
                  }}
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
          <div style={{ marginTop: 6, fontFamily: 'var(--font-body)', fontSize: 'var(--text-sm)', lineHeight: 1.55, color: 'var(--text-tertiary)' }}>
            Counted from the day you planted this tree, never the calendar week. Days are for anyone whose hashtag counts them — #100DaysOfCode and the card should agree.
          </div>

          <div style={{ marginTop: 16 }}>
            <Switch checked={ledgerOn} onChange={chooseLedger} label="Carry the ledger" />
            <div style={{ marginTop: 6, fontFamily: 'var(--font-body)', fontSize: 'var(--text-sm)', lineHeight: 1.55, color: 'var(--text-tertiary)' }}>
              The row of ticks along the bottom — one per week since you planted. It is the single element that makes a series read as a series, and it publishes your quiet weeks too.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
