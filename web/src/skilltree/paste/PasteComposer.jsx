// The paste composer (F3 §02): a plain text well whose gutter IS the live parse —
// ◉ root · ├ branch · · step · ✓ arrives done · ¶ kept as a note — measured with an
// invisible mirror so every glyph sits exactly on its (wrapped) line. The preview is
// the confirmation: no separate confirm step, no red ever. The deterministic parser
// is the only door into TreeData — the optional AI handle below only ever rewrites
// the TEXT — streamed into the well as the model speaks — which then walks through
// the same parser like anything typed.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { KindLegend } from '../../components/tree/KindLegend.jsx';
import { withCounts, renameKind, recolorKind, describeKind, addKind, removeKind } from '../model/Legend.js';
import { NODE_COLORS } from '../theme.js';
import { API_BASE } from '../apiBase.js';
import { readComposeStream } from './composeStream.js';
import { reportError } from '../../telemetry/beacon.js';

const PLACEHOLDER = 'Paste anything — a to-do list, an outline, markdown checkboxes.';
const AI_RESET_MS = 5000;
const SHAPE_TIMEOUT_MS = 90000;  // the server's stream deadline; the abort tears the reader down
const COMPOSE_TEXT_MAX_BYTES = 24576; // the server's cap — over it the handle never offers
const AI_COPY = {
  handle: 'Looks like notes — shape it into a plan',
  handleAny: 'Shape this into a plan',
  shape: 'Shape',
  honesty: 'Sends your text to an AI model to draft the steps — only when you tap.',
  more: 'What’s sent?',
  less: 'Hide',
  detail: 'Shaping sends the text in this box to a third-party AI model to draft a plan. It runs only when you tap Shape. Windmill doesn’t store the text or the result.',
  shaping: 'Shaping your plan…',
  cancel: 'Cancel',
  kept: 'Your text — kept',
  undo: 'Shaped into a plan · undo to go back',
  stopped: 'Couldn’t finish shaping — here’s what arrived. Your text is safe, one undo away.',
  rate: 'That’s a few in a row. Give it a minute and the shape offer comes back — your text is right here, untouched.',
  fail: 'Couldn’t reach the model just now. Your text is exactly as you left it.',
  long: 'Too long to shape',
  retry: 'Try again',
  undoDoor: 'Undo',
};

// A 503 compose-unavailable hides the handle for the whole session, without a message.
let composeUnavailable = false;

export function PasteComposer({ text, onTextChange, kinds, onKindsChange, parse, budName, planting, onClose, onPlant, sheet = false, append = false }) {
  const [name, setName] = useState(budName ?? '');
  const [legendOpen, setLegendOpen] = useState(false);
  const [glyphTops, setGlyphTops] = useState([]);
  const [ai, setAi] = useState({ phase: 'idle', prior: null });
  const [honestyOpen, setHonestyOpen] = useState(false);
  const [aiHidden, setAiHidden] = useState(() => composeUnavailable);
  const mirrorRef = useRef(null);
  const textRef = useRef(null);
  const nameRef = useRef(null);
  const aiTimer = useRef(null);
  const shapeGen = useRef(0);   // bumped on unmount/Esc/new-shape — a stale reply has no seat
  const shapeAbort = useRef(null);
  const streamedText = useRef(null); // the stream's last flush — tells its own writes from outside edits

  const hasText = text.trim() !== '';
  const lines = useMemo(() => text.split(/\r\n|\r|\n/), [text]);

  // The well takes focus on the desktop dock; the sheet's peek is readout + Plant,
  // so it never pops the keyboard uninvited.
  useEffect(() => {
    if (sheet) return;
    const well = textRef.current;
    if (!well) return;
    well.focus();
    well.setSelectionRange(well.value.length, well.value.length);
  }, [sheet]);

  // The mirror-measure: one rAF after every text change reads each mirrored line's
  // offsetTop, so glyphs track soft wrapping exactly.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const mirror = mirrorRef.current;
      if (!mirror) return;
      setGlyphTops([...mirror.children].map((child) => child.offsetTop));
    });
    return () => cancelAnimationFrame(raf);
  }, [lines]);

  useEffect(() => () => {
    shapeGen.current += 1;
    shapeAbort.current?.abort();
    clearTimeout(aiTimer.current);
  }, []);

  // The well is readOnly while shaping, so a text change mid-shape is either the stream's
  // own flush landing or external — a dropped plan file replacing the draft. The stream is
  // append-only, so a committed text that PREFIXES the latest flush is just a stale frame
  // racing the ref (killing on it would strand the partial with no undo); only genuinely
  // foreign text retires the stream.
  useEffect(() => {
    if (ai.phase !== 'shaping') return;
    if (text === streamedText.current) return;
    if (streamedText.current !== null && streamedText.current.startsWith(text)) return;
    shapeGen.current += 1;
    shapeAbort.current?.abort();
    setAi({ phase: 'idle', prior: null });
  }, [text]);

  // The drop door retires the stream synchronously, ahead of any pending rAF flush —
  // the event fires before the drop's setDraft, so the flush's generation check fails
  // and the dropped file can never be overwritten by a late stream write.
  useEffect(() => {
    const onReplaced = () => {
      if (ai.phase !== 'shaping') return;
      shapeGen.current += 1;
      shapeAbort.current?.abort();
      streamedText.current = null;
      setAi({ phase: 'idle', prior: null });
    };
    window.addEventListener('wm-draft-replaced', onReplaced);
    return () => window.removeEventListener('wm-draft-replaced', onReplaced);
  }, [ai.phase]);

  // The composer owns its keys: Esc back to the bud (draft kept), ⌘↵ plants, and
  // nothing leaks out to the birth input's own Esc → history.back().
  const onKeyDown = (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      plant();
    }
  };

  const editText = (next) => {
    if (ai.phase === 'undo' || ai.phase === 'stopped') setAi({ phase: 'idle', prior: null });
    onTextChange(next);
  };

  function plant() {
    if (planting || !hasText) return;
    // Append hands the raw parse to the parent, which owns the graft transform — there is
    // no name gate (a headless list attaches directly; append never forces a wrapper name).
    if (append) {
      onPlant(parse);
      return;
    }
    if (parse.missingRoot && name.trim() === '') {
      nameRef.current?.focus();
      return;
    }
    const title = parse.missingRoot ? name.trim().slice(0, 200) : parse.title;
    const nodes = parse.missingRoot ? parse.nodes.map((node, i) => (i === 0 ? { ...node, label: title } : node)) : parse.nodes;
    onPlant({ title, nodes, kinds: parse.kinds.map(({ id, hue, label, description }) => ({ id, hue, label, description })) });
  }

  // Legend edits are pure Legend.js ops over the LOCAL draft, which feeds straight
  // back into parsePlan. Editing a kind the parse minted adopts it into the draft, so
  // it stops being provisional and keeps its heading's binding.
  const draftIds = new Set(kinds.map((kind) => kind.id));
  const adopt = (id, patch) => {
    const minted = parse.kinds.find((kind) => kind.id === id);
    if (!minted) return;
    const hue = patch.hue ?? minted.hue;
    if (kinds.some((kind) => kind.hue === hue)) return;
    onKindsChange([...kinds, {
      id: minted.id,
      hue,
      label: (patch.label ?? minted.label).slice(0, 24),
      description: patch.description ?? minted.description,
    }]);
  };

  // The shape door. It used to open only for text that read as loose notes — six or more spoken
  // lines, sixty percent of them prose — which meant the one paste that most wants shaping, a
  // document someone already wrote, arrived as a wall of headings and got no offer at all. So the
  // handle is now offered for anything with real content in it. The grammar still parses every
  // paste on its own; shaping is the way to a better plan, not a rescue from a broken one.
  // Text past the server's byte cap keeps it quiet: a handle that can only fail is no handle.
  const spoken = parse.gutter.filter((entry) => entry.glyph !== null);
  const prose = spoken.length >= 6 && spoken.filter((entry) => entry.glyph === '¶').length / spoken.length >= 0.6;
  const shapeable = spoken.length >= 3 && new TextEncoder().encode(text).length <= COMPOSE_TEXT_MAX_BYTES;
  const aiVisible = !aiHidden && (shapeable || ai.phase !== 'idle');

  const settleAi = (phase) => {
    setAi({ phase, prior: null });
    clearTimeout(aiTimer.current);
    aiTimer.current = setTimeout(() => setAi({ phase: 'idle', prior: null }), AI_RESET_MS);
  };

  // Shaping streams: the request asks for SSE and every delta grows the well text on
  // your eyes — the parser, gutter and ghost animate on their ordinary keystroke paths,
  // throttled to one flush per animation frame. A reply that isn't a stream (an older
  // server, or any pre-stream error) walks the buffered road; a stream that breaks
  // before its first word gets one buffered retry. The pre-shape text taken here is
  // the undo slot either way — even when the stream stops mid-plan.
  async function shape(source = text) {
    if (ai.phase === 'shaping') return;
    const prior = source;
    const gen = ++shapeGen.current;
    const controller = new AbortController();
    shapeAbort.current = controller;
    streamedText.current = null;
    const deadline = setTimeout(() => controller.abort(), SHAPE_TIMEOUT_MS);
    setAi({ phase: 'shaping', prior });

    const compose = (stream) => fetch(`${API_BASE}/v1/compose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(stream ? { text: prior, stream: true } : { text: prior }),
      signal: controller.signal,
    });

    // Shaping failing quietly is how a broken feature stays broken: the well keeps your text, the
    // handle stays calm, and nothing anywhere goes red. So every failure the reader actually SEES
    // is reported — the reason and the size of the attempt only. The text itself is never sent:
    // it is the user's, and it is the one thing an error tracker must not keep.
    const reportShapeFailure = (reason) =>
      reportError(new Error(`shape ${reason} (${new TextEncoder().encode(prior).length}B)`), 'shape');

    const settleUndo = () => {
      setAi({ phase: 'undo', prior });
      clearTimeout(aiTimer.current);
      aiTimer.current = setTimeout(() => setAi((current) => (current.phase === 'undo' ? { phase: 'idle', prior: null } : current)), AI_RESET_MS);
    };

    const settleBuffered = async (response) => {
      const body = response ? await response.json().catch(() => null) : null;
      if (gen !== shapeGen.current) return; // Esc'd, unmounted or superseded — the reply has no seat
      if (response?.ok && typeof body?.plan === 'string') {
        streamedText.current = body.plan;
        onTextChange(body.plan);
        settleUndo();
        return;
      }
      if (response?.status === 503 && body?.code === 'compose-unavailable') {
        reportShapeFailure('unavailable');
        composeUnavailable = true;
        setAiHidden(true);
        setAi({ phase: 'idle', prior: null });
        return;
      }
      if (response?.status === 429) {
        settleAi('rate');
        return;
      }
      if (response?.status === 400 && body?.code === 'too-long') {
        settleAi('long');
        return;
      }
      reportShapeFailure(response ? `failed (${response.status})` : 'unreachable');
      settleAi('fail');
    };

    try {
      let response = null;
      try {
        response = await compose(true);
      } catch { /* network, timeout or abort — the quiet failure below */ }
      if (gen !== shapeGen.current) return;
      const streaming = response?.ok && (response.headers.get('content-type') ?? '').includes('text/event-stream') && response.body;
      if (!streaming) {
        await settleBuffered(response);
        return;
      }

      let streamed = '';
      let flushRaf = 0;
      const flush = () => {
        flushRaf = 0;
        if (gen !== shapeGen.current) return;
        streamedText.current = streamed;
        onTextChange(streamed);
      };
      let outcome = null;
      try {
        outcome = await readComposeStream(response.body, (chunk) => {
          if (gen !== shapeGen.current) return;
          streamed += chunk;
          if (flushRaf === 0) flushRaf = requestAnimationFrame(flush);
        });
      } catch { /* aborted, timed out or the pipe broke — settled by what already streamed */ }
      cancelAnimationFrame(flushRaf);
      if (gen !== shapeGen.current) return;

      if (streamed === '') {
        if (outcome === 'fail') {
          reportShapeFailure('failed before its first word');
          settleAi('fail'); // the model stopped before its first word — the text is untouched
          return;
        }
        let retry = null; // the stream broke before its first word — one buffered retry
        try {
          retry = await compose(false);
        } catch { /* the quiet failure below */ }
        if (gen !== shapeGen.current) return;
        await settleBuffered(retry);
        return;
      }

      streamedText.current = streamed;
      onTextChange(streamed); // the last flush — everything the stream managed to say stays visible
      if (outcome === 'done') {
        settleUndo();
        return;
      }
      reportShapeFailure(`stopped mid-plan after ${streamed.length} chars`);
      setAi({ phase: 'stopped', prior }); // the partial plan is kept; the handle itself is the undo
    } finally {
      clearTimeout(deadline);
    }
  }

  // The original is one tap away the whole time: while shaping, restore aborts the stream
  // and hands the words back; after (undo / a stopped partial), it just swaps the text in.
  const restore = () => {
    if (ai.phase === 'shaping') {
      shapeGen.current += 1;
      shapeAbort.current?.abort();
      streamedText.current = null;
    }
    clearTimeout(aiTimer.current);
    if (ai.prior !== null) onTextChange(ai.prior);
    setAi({ phase: 'idle', prior: null });
  };

  // Try again re-fires the shape from the ORIGINAL notes — the stopped partial keeps them in
  // ai.prior, a pre-stream fail never touched the well — and shape's generation bump retires
  // whatever the last attempt left in flight.
  const tryAgain = () => {
    const source = ai.phase === 'stopped' ? ai.prior : text;
    clearTimeout(aiTimer.current);
    shape(source);
  };

  const readout = [`${parse.readout.steps} step${parse.readout.steps === 1 ? '' : 's'}`];
  if (parse.readout.branches > 0) readout.push(`${parse.readout.branches} branch${parse.readout.branches === 1 ? '' : 'es'}`);
  if (parse.readout.done > 0) readout.push(`${parse.readout.done} already done`);

  const notes = parse.imperfections.filter((entry) => entry.type === 'note').length;
  const clamps = parse.imperfections.filter((entry) => entry.type === 'clamp').length;
  const renames = parse.imperfections.filter((entry) => entry.type === 'rename').length;
  const chip = [];
  if (notes > 0) chip.push(`${notes} line${notes === 1 ? '' : 's'} → note${notes === 1 ? '' : 's'}`);
  if (clamps > 0) chip.push(`${clamps} clamped`);
  if (renames > 0) chip.push(`${renames} renamed`);

  const head = (
    <header className="pc-head">
      <h2 className="pc-title">{append ? 'Add to this tree' : 'Paste a plan'}</h2>
      <button type="button" className="pc-close" onClick={onClose} aria-label="Close">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </header>
  );

  const well = (
    <div className="pc-well">
      <div className="pc-well-inner">
        {hasText && (
          <div className="pc-gutter" aria-hidden="true">
            {parse.gutter.map((entry, index) => {
              if (entry.glyph === null || glyphTops[index] === undefined) return null;
              const tone = entry.glyph === '✓' ? ' pc-glyph--done' : entry.glyph === '¶' ? ' pc-glyph--note' : '';
              return (
                <span key={index} className={`pc-glyph${tone}${entry.liberty ? ' pc-glyph--liberty' : ''}`} style={{ top: glyphTops[index] }} title={entry.liberty ?? undefined}>
                  {entry.glyph}
                </span>
              );
            })}
          </div>
        )}
        <div className="pc-mirror" ref={mirrorRef} aria-hidden="true">
          {lines.map((line, index) => <div key={index}>{line === '' ? ' ' : line}</div>)}
        </div>
        <textarea
          ref={textRef}
          className="pc-text"
          value={text}
          onChange={(event) => editText(event.target.value)}
          placeholder={PLACEHOLDER}
          readOnly={planting || ai.phase === 'shaping'}
          spellCheck={false}
          aria-label="Paste a plan"
        />
      </div>
    </div>
  );

  const nameField = !append && parse.missingRoot && hasText && (
    <label className="pc-name">
      <span>Give it a name to plant</span>
      <input ref={nameRef} value={name} onChange={(event) => setName(event.target.value)} aria-label="Give it a name to plant" />
    </label>
  );

  const legend = (
    <div className="pc-legend">
      <div className="pc-legend-row">
        <div className="pc-chips">
          {parse.kinds.map((kind) => (
            <span key={kind.id} className="pc-chip">
              <i style={{ background: NODE_COLORS[kind.hue]?.base }} />
              {kind.label || kind.hue.charAt(0).toUpperCase() + kind.hue.slice(1)}
            </span>
          ))}
        </div>
        <button type="button" className="pc-quiet" onClick={() => setLegendOpen((open) => !open)}>Edit legend</button>
      </div>
      {legendOpen && (
        <div className="pc-legend-editor">
          <KindLegend
            kinds={withCounts(parse.kinds, parse.nodes)}
            defaultOpen
            onOpenChange={(open) => { if (!open) setLegendOpen(false); }}
            onRename={(id, label) => (draftIds.has(id) ? onKindsChange(renameKind(kinds, id, label)) : adopt(id, { label }))}
            onRecolor={(id, hue) => (draftIds.has(id) ? onKindsChange(recolorKind(kinds, id, hue).legend) : adopt(id, { hue }))}
            onDescribe={(id, description) => (draftIds.has(id) ? onKindsChange(describeKind(kinds, id, description)) : adopt(id, { description }))}
            onAdd={(hue) => onKindsChange(addKind(kinds, hue))}
            onRemove={(id) => onKindsChange(removeKind(kinds, id))}
          />
        </div>
      )}
    </div>
  );

  // The shape zone wears one face per phase: the idle handle carries the offer line, the
  // Shape door and the honesty disclosure (the tap is the consent); shaping shows the live
  // status + Cancel; the outcomes read back where the text is and offer Try again / undo.
  // The kept strip rides shaping and the after-states — the words are never gone.
  const keptVisible = ai.phase === 'shaping' || ai.phase === 'undo' || ai.phase === 'stopped';
  const shapeZone = aiVisible && (
    <div className="pc-shape">
      {ai.phase === 'idle' && (
        <div className="pc-shape-idle">
          <div className="pc-shape-offer">
            <span className="pc-shape-line">{prose ? AI_COPY.handle : AI_COPY.handleAny}</span>
            <button type="button" className="pc-shape-do" onClick={() => shape()} disabled={planting}>{AI_COPY.shape}</button>
          </div>
          <div className="pc-shape-honesty">
            <span className="pc-shape-note">{AI_COPY.honesty}</span>
            <button type="button" className="pc-shape-more" aria-expanded={honestyOpen} onClick={() => setHonestyOpen((open) => !open)}>
              {honestyOpen ? AI_COPY.less : AI_COPY.more}
            </button>
          </div>
          {honestyOpen && <p className="pc-shape-detail">{AI_COPY.detail}</p>}
        </div>
      )}

      {ai.phase === 'shaping' && (
        <div className="pc-shape-status">
          <span className="pc-ai-dot" />
          <span className="pc-shape-writing">{AI_COPY.shaping}</span>
          <button type="button" className="pc-shape-cancel" onClick={restore}>{AI_COPY.cancel}</button>
        </div>
      )}

      {ai.phase === 'undo' && (
        <button type="button" className="pc-shape-done" onClick={restore}>{AI_COPY.undo}</button>
      )}

      {ai.phase === 'stopped' && (
        <div className="pc-shape-degrade">
          <span className="pc-shape-degrade-line">{AI_COPY.stopped}</span>
          <div className="pc-shape-doors">
            <button type="button" className="pc-shape-do" onClick={tryAgain} disabled={planting}>{AI_COPY.retry}</button>
            <button type="button" className="pc-shape-undo" onClick={restore}>{AI_COPY.undoDoor}</button>
          </div>
        </div>
      )}

      {ai.phase === 'fail' && (
        <div className="pc-shape-degrade">
          <span className="pc-shape-degrade-line">{AI_COPY.fail}</span>
          <button type="button" className="pc-shape-do" onClick={tryAgain} disabled={planting}>{AI_COPY.retry}</button>
        </div>
      )}

      {ai.phase === 'rate' && <span className="pc-shape-degrade-line">{AI_COPY.rate}</span>}
      {ai.phase === 'long' && <span className="pc-shape-degrade-line">{AI_COPY.long}</span>}

      {keptVisible && (
        <button type="button" className="pc-shape-kept" onClick={restore} disabled={planting}>{AI_COPY.kept}</button>
      )}
    </div>
  );

  const foot = (
    <footer className="pc-foot">
      {(hasText || chip.length > 0) && (
        <div className="pc-foot-line">
          {hasText && <span className="pc-readout">{readout.join(' · ')}</span>}
          {chip.length > 0 && <span className="pc-imperfect">{chip.join(' · ')}</span>}
        </div>
      )}
      {shapeZone}
      <button type="button" className="birth-plant pc-plant" disabled={!hasText || planting} onClick={plant}>
        {planting ? (append ? 'Adding…' : 'Planting…') : (append ? 'Add to tree' : 'Plant')}
        {!planting && <kbd className="pc-kbd">⌘↵</kbd>}
      </button>
    </footer>
  );

  if (sheet) {
    // The X5 sheet order: everything the 216px peek must show first — title, readout,
    // chip, Plant — then the well and legend for the expanded reach.
    return (
      <section className="pc pc--sheet" onKeyDown={onKeyDown}>
        {head}
        {foot}
        {nameField}
        {well}
        {legend}
      </section>
    );
  }

  return (
    <section className="pc" onKeyDown={onKeyDown}>
      {head}
      {well}
      {nameField}
      {legend}
      {foot}
    </section>
  );
}

export default PasteComposer;
