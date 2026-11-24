// A plain text well whose gutter is the live parse — ◉ root · ├ branch · · step · ✓ arrives done ·
// ¶ kept as a note — measured with an invisible mirror so every glyph sits on its wrapped line.
// The deterministic parser is the only door into TreeData.
// The parse holds values alone: this file draws each line's mark and words each liberty taken.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { KindLegend } from '../graph/tree/KindLegend.jsx';
import { withCounts, renameKind, recolorKind, describeKind, addKind, removeKind, kindName } from '../model/Legend.js';
import { KIND_CSS } from '../theme.js';
import { graftedStepCount } from './graftPlan.js';
import { plantedRoadmap } from './planGrammar.js';
import { LABELS } from '../copy.js';
import { t } from '../i18n/index.js';

const PLACEHOLDER = t('roadmap.paste.placeholder');

const GLYPHS = { root: '◉', branch: '├', step: '·', done: '✓', note: '¶' };
const CLAMP_WORDS = { ragged: t('roadmap.paste.mixedIndentClamped'), jump: t('roadmap.paste.indentClamped') };

// What a line's liberty says: each type the grammar takes has its words.
function libertyWords(liberty) {
  if (liberty.type === 'rename') return t('roadmap.paste.renamedTo', { label: liberty.label });
  if (liberty.type === 'clamp') return CLAMP_WORDS[liberty.indent];
  if (liberty.type === 'clip') return t('roadmap.paste.shortenedToFit');
  return t('roadmap.paste.keptAsNote');
}

export function PasteComposer({ text, onTextChange, kinds, onKindsChange, parse, budName, planting, onClose, onPlant, sheet = false, append = false }) {
  const [name, setName] = useState(budName ?? '');
  const [legendOpen, setLegendOpen] = useState(false);
  const [glyphTops, setGlyphTops] = useState([]);
  const mirrorRef = useRef(null);
  const textRef = useRef(null);
  const nameRef = useRef(null);

  const hasText = text.trim() !== '';
  const lines = useMemo(() => text.split(/\r\n|\r|\n/), [text]);

  // The well takes focus on the desktop dock only, so the sheet never pops the keyboard uninvited.
  useEffect(() => {
    if (sheet) return;
    const well = textRef.current;
    if (!well) return;
    well.focus();
    well.setSelectionRange(well.value.length, well.value.length);
  }, [sheet]);

  // One rAF after every text change reads each mirrored line's offsetTop, so glyphs track wrapping.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const mirror = mirrorRef.current;
      if (!mirror) return;
      setGlyphTops([...mirror.children].map((child) => child.offsetTop));
    });
    return () => cancelAnimationFrame(raf);
  }, [lines]);

  // Esc goes back to the bud with the draft kept and ⌘↵ plants; nothing leaks out to the bud.
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

  function plant() {
    if (planting || !hasText) return;
    // Append hands the raw parse to the parent, which owns the graft transform: no name gate.
    if (append) {
      onPlant(parse);
      return;
    }
    // The name field shows only for a plan with no name of its own, so a name typed for an earlier text names no other.
    const roadmap = plantedRoadmap(parse, parse.missingRoot ? name : '');
    if (roadmap === null) {
      nameRef.current?.focus();
      return;
    }
    onPlant(roadmap);
  }

  // Legend edits are Legend.js ops over the local draft, which feeds back into parsePlan. Editing
  // a kind the parse minted adopts it into the draft, keeping its heading's binding.
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

  const steps = append ? graftedStepCount(parse) : parse.readout.steps;
  const readout = [t('roadmap.paste.steps', { count: steps })];
  if (parse.readout.branches > 0) readout.push(t('roadmap.paste.branches', { count: parse.readout.branches }));
  if (parse.readout.done > 0) readout.push(t('roadmap.paste.alreadyDone', { count: parse.readout.done }));

  const { notes, clamps, renames } = parse.imperfections;
  const chip = [];
  if (notes > 0) chip.push(t('roadmap.paste.notes', { count: notes }));
  if (clamps > 0) chip.push(t('roadmap.paste.clamped', { count: clamps }));
  if (renames > 0) chip.push(t('roadmap.paste.renamed', { count: renames }));

  const head = (
    <header className="pc-head">
      <h2 className="pc-title">{append ? t('roadmap.paste.titleAppend') : t('roadmap.paste.title')}</h2>
      <button type="button" className="pc-close" onClick={onClose} aria-label={LABELS.close}>
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
              if (entry.mark === null || glyphTops[index] === undefined) return null;
              const tone = entry.mark === 'done' ? ' pc-glyph--done' : entry.mark === 'note' ? ' pc-glyph--note' : '';
              const taken = entry.liberties.length > 0;
              return (
                <span key={index} className={`pc-glyph${tone}${taken ? ' pc-glyph--liberty' : ''}`} style={{ top: glyphTops[index] }} title={taken ? entry.liberties.map(libertyWords).join(' · ') : undefined}>
                  {GLYPHS[entry.mark]}
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
          onChange={(event) => onTextChange(event.target.value)}
          placeholder={PLACEHOLDER}
          readOnly={planting}
          spellCheck={false}
          aria-label={t('roadmap.paste.title')}
        />
      </div>
    </div>
  );

  const nameField = !append && parse.missingRoot && hasText && (
    <label className="pc-name">
      <span>{t('roadmap.paste.nameToPlant')}</span>
      <input ref={nameRef} value={name} onChange={(event) => setName(event.target.value)} aria-label={t('roadmap.paste.nameToPlant')} />
    </label>
  );

  const legend = (
    <div className="pc-legend">
      <div className="pc-legend-row">
        <div className="pc-chips">
          {parse.kinds.map((kind) => (
            <span key={kind.id} className="pc-chip">
              <i style={{ background: KIND_CSS[kind.hue]?.base }} />
              {kindName(kind)}
            </span>
          ))}
        </div>
        <button type="button" className="pc-quiet" onClick={() => setLegendOpen((open) => !open)}>{t('roadmap.paste.editLegend')}</button>
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

  const foot = (
    <footer className="pc-foot">
      {(hasText || chip.length > 0) && (
        <div className="pc-foot-line">
          {hasText && <span className="pc-readout">{readout.join(' · ')}</span>}
          {chip.length > 0 && <span className="pc-imperfect">{chip.join(' · ')}</span>}
        </div>
      )}
      <button type="button" className="birth-plant pc-plant" disabled={!hasText || planting} onClick={plant}>
        {planting ? (append ? t('roadmap.paste.adding') : t('roadmap.paste.planting')) : (append ? t('roadmap.paste.add') : t('roadmap.paste.plant'))}
        {!planting && <kbd className="pc-kbd">⌘↵</kbd>}
      </button>
    </footer>
  );

  if (sheet) {
    // Sheet order: everything the peek must show first — title, readout, chip, Plant — then the rest.
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
