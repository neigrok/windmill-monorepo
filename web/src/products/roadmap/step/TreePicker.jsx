// The tree picker: one of the person's own roadmaps for a step to open. From 744px it is a page in the step modal, and
// on phones a full-screen page with the field and the commit in the reach band. A pasted address of a roadmap the
// person can only read is forked first, and the copy is then a row to choose: Fork never attaches by itself.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronLeft } from 'lucide-react';
import { Button } from '../../../design-system';
import { track } from '../../../telemetry/beacon.js';
import { handleMenuKey } from '../board/BoardControls.jsx';
import { boardKey } from '../shortcuts/shortcutMap.js';
import { ForkDoor } from '../share/ForkDoor.jsx';
import { pageWatching, reportRoadmapFailure } from '../reportFailure.js';
import { PickerSearch } from './PrerequisitePicker.jsx';
import { TreeChoices } from './TreeChoices.js';
import { coverBeneath, useComposerFocus, useComposerViewport } from './composerFocus.js';
import { LOAD_ERROR, PICKER, backTo, formatCount, pickerFor, treeProgress } from '../copy.js';
import { t } from '../i18n/index.js';
import './composer.css';

// `trees` reads the person's roadmaps (`list`) and the roadmap an address names (`read`). `attachment(complete)` says
// what attaching a tree, complete or not, does to a hand's mark on the step. `onAttach(treeId)` answers `{ ok }`.
export function TreePicker({ step, treeId, standing, attachment, trees, layout, headingId, band, view, onAttach, onCancel }) {
  const phone = layout === 'phone';
  const layer = useRef(null);
  const region = useRef(null);
  const search = useRef(null);
  const rowList = useRef(null);
  const reported = useRef(false);
  const [choices, setChoices] = useState(null);
  const [unread, setUnread] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [forking, setForking] = useState(false);
  const viewport = useComposerViewport(phone);
  const trapTab = useComposerFocus(region, phone, { restore: false });

  useLayoutEffect(() => (phone ? coverBeneath(layer.current) : undefined), [phone]);

  useLayoutEffect(() => {
    if (!phone) search.current.focus({ preventScroll: true });
  }, [phone]);

  // A read that failed with someone waiting on it reports once for the picker; a refusal and a lost connection do not.
  const readFailed = (status) => {
    if (reported.current || (status === 0 ? !pageWatching() : status < 500)) return;
    reported.current = true;
    reportRoadmapFailure('roadmap-tree-picker-load', new Error('Roadmap tree picker read failed'));
  };

  useEffect(() => {
    let wanted = true;
    trees.list().then(({ rows, authoritative, status }) => {
      if (!wanted) return;
      setUnread(!authoritative);
      if (!authoritative) {
        readFailed(status);
        return;
      }
      const others = rows.filter((row) => row.id !== treeId)
        .map((row) => ({ id: row.id, title: row.title?.trim() || t('roadmap.common.untitled'), done: row.done ?? 0, total: row.total ?? 0 }));
      setChoices((current) => (current ? current.listed(others) : new TreeChoices({ rows: others, standing })));
    });
    return () => { wanted = false; };
  }, [attempt]);

  const address = choices?.unresolved ? choices.address : null;
  useEffect(() => {
    if (address === null) return undefined;
    let wanted = true;
    trees.read(address).then((card) => ({ id: address, card }), (error) => {
      readFailed(error?.status ?? 0);
      return { id: address, failed: true };
    }).then((pasted) => {
      if (wanted) setChoices((current) => current.resolved(pasted));
    });
    return () => { wanted = false; };
  }, [address]);

  const outcome = choices?.outcome ?? null;
  useEffect(() => {
    if (outcome) track('roadmap_tree_attach', { step: 'paste', outcome, band, view });
  }, [choices?.address, outcome]);

  const blocked = choices?.blocked ?? null;
  const failed = unread || Boolean(choices?.failed);
  const listed = choices !== null && !failed;
  const mark = listed && !blocked && choices.rows.length > 0
    ? attachment(Boolean(choices.chosenRow) && choices.chosenRow.total > 0 && choices.chosenRow.done === choices.chosenRow.total)
    : null;
  const counted = listed && !choices.unresolved;
  const context = counted && choices.searched
    ? t('roadmap.treePicker.forMatches', { step, count: choices.count, shown: formatCount(choices.count) })
    : counted && choices.rows.length > 0
      ? t('roadmap.treePicker.forTrees', { step, count: choices.rows.length, shown: formatCount(choices.rows.length) })
      : pickerFor({ step, total: null });
  const unmatched = counted && choices.searched && choices.count === 0 && choices.outcome !== 'unreadable';
  const tabStop = choices?.shown.find((row) => row.id === choices.chosen)?.id ?? choices?.shown[0]?.id ?? null;

  const clear = () => {
    setChoices(choices.search(''));
    search.current.focus();
  };
  const retry = () => {
    if (choices?.failed) setChoices(choices.resolved(null));
    else setAttempt((count) => count + 1);
    (phone ? region : search).current.focus({ preventScroll: true });
  };
  const fork = () => {
    track('roadmap_tree_attach', { step: 'fork', band, view });
    setForking(true);
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    const typing = event.target.matches('input, textarea') || event.target.isContentEditable;
    if (boardKey(event, { typing }) === 'find') {
      event.preventDefault();
      event.stopPropagation();
      search.current.focus();
      return;
    }
    trapTab(event);
  };

  const searchField = (
    <PickerSearch inputRef={search} label={t('roadmap.treePicker.findTree')} value={choices?.query ?? ''} phone={phone}
      onChange={(query) => { if (choices) setChoices(choices.search(query)); }} onClear={clear} />
  );
  const commit = blocked
    ? <button type="button" className="st-board-step-action st-board-step-action--primary" onClick={fork}>{t('roadmap.treePicker.forkTree')}</button>
    : <button type="button" className="st-board-step-action st-board-step-action--primary" disabled={!listed || !choices.attachable} onClick={() => onAttach(choices.chosen)}>{t('roadmap.treePicker.attach')}</button>;
  const forkLine = !blocked && <p className="st-board-tree-picker-fork">{t('roadmap.treePicker.forkFirst')}</p>;

  const page = (
    <div ref={region} tabIndex={-1} className={`st-board-picker st-board-tree-picker st-board-picker--${layout}`} onKeyDown={onKeyDown}
      {...(phone ? { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': headingId } : {})}>
      <header className="st-board-draft-heading">
        {phone
          ? <button className="st-board-draft-cancel" type="button" onClick={onCancel}>{PICKER.cancel}</button>
          : <button className="st-board-picker-back" type="button" aria-label={backTo({ screen: step })} onClick={onCancel}><ChevronLeft size={20} aria-hidden /></button>}
        <div className="st-board-picker-heading-copy">
          <h2 id={headingId}>{t('roadmap.treePicker.title')}</h2>
          {!phone && <p className="st-board-picker-context">{context}</p>}
        </div>
        {phone && <span className="st-board-draft-balance" />}
      </header>
      {phone ? <p className="st-board-picker-context">{context}</p> : searchField}
      <div className="st-board-picker-results" tabIndex={-1}>
        {failed && (
          <div className="st-board-tree-picker-unread" role="alert">
            <p>{t('roadmap.treePicker.loadFailed')}</p>
            <Button variant="secondary" onClick={retry}>{LOAD_ERROR.action}</Button>
          </div>
        )}
        {listed && choices.shown.length > 0 && (
          <div ref={rowList} className="st-board-tree-picker-rows" role="radiogroup" aria-labelledby={headingId}
            onKeyDown={(event) => handleMenuKey(event, { root: rowList.current, selector: '[role="radio"]' })}>
            {choices.shown.map((row) => (
              <button
                key={row.id}
                type="button"
                role="radio"
                aria-checked={row.id === choices.chosen}
                tabIndex={row.id === tabStop ? 0 : -1}
                className="st-board-picker-row st-board-tree-picker-row"
                onClick={() => setChoices(choices.choose(row.id))}
              >
                <span className="st-board-picker-row-text">
                  <strong>{row.title}</strong>
                  <span>{treeProgress(row)}</span>
                </span>
                <span className="st-board-tree-picker-choice" aria-hidden>
                  {row.id === choices.chosen ? <Check size={20} strokeWidth={1.73} /> : <span className="st-board-tree-picker-radio" />}
                </span>
              </button>
            ))}
          </div>
        )}
        {blocked && (
          <>
            <div role="radio" aria-checked="false" aria-disabled="true" className="st-board-picker-row st-board-tree-picker-row is-blocked">
              <span className="st-board-picker-row-text">
                <strong>{blocked.title.trim() || t('roadmap.common.untitled')}</strong>
                <span>{blocked.author ? t('roadmap.treePicker.readableBy', { author: blocked.author }) : t('roadmap.treePicker.readable')}</span>
              </span>
            </div>
            <p className="st-board-tree-picker-line st-board-tree-picker-line--rule">{t('roadmap.treePicker.ownOnly')}</p>
          </>
        )}
        {listed && choices.outcome === 'unreadable' && <p className="st-board-tree-picker-line" role="status">{t('roadmap.treePicker.unreadable')}</p>}
        {listed && !choices.searched && choices.rows.length === 0 && <p className="st-board-tree-picker-line" role="status">{t('roadmap.treePicker.noOthers')}</p>}
        {unmatched && (
          <div className="st-board-picker-empty" role="status">
            <h3>{t('roadmap.treePicker.noMatch', { query: choices.query.trim() })}</h3>
            {choices.chosen !== '' && <p>{PICKER.selectionKept}</p>}
            <Button variant="secondary" onClick={clear}>{PICKER.clearSearch}</Button>
          </div>
        )}
        {mark?.marked && !unmatched && choices.outcome !== 'unreadable' && (
          <p className="st-board-tree-picker-line">{t('roadmap.treePicker.markAside', { count: mark.relocks, shown: formatCount(mark.relocks) })}</p>
        )}
      </div>
      <footer className="st-board-picker-footer">
        {phone && forkLine}
        <div className="st-board-picker-actions">
          {phone ? searchField : <>{forkLine}<button type="button" className="st-board-step-action st-board-step-action--secondary" onClick={onCancel}>{PICKER.cancel}</button></>}
          {commit}
        </div>
      </footer>
      {forking && blocked && (
        <ForkDoor open presentation={phone ? 'sheet' : 'dialog'} treeId={blocked.id} signedIn stepCount={blocked.steps || null}
          onClose={() => setForking(false)}
          onForked={() => {
            setForking(false);
            setAttempt((count) => count + 1);
            (phone ? region : search).current.focus({ preventScroll: true });
          }} />
      )}
    </div>
  );
  if (!phone) return page;
  return createPortal(<div ref={layer} style={viewport.style} className="st-board-composer-layer is-phone">{page}</div>, document.body);
}
