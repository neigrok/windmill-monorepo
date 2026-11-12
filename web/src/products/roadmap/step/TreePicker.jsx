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

// An address in the field is read once it has been still this long, or at once when it was pasted.
const ADDRESS_STILL_MS = 300;

// Why a read failed, by what the server answered: 0 for no answer, and 200 for an answer that is not what was asked for.
function failureOf(status) {
  if (status === 0) return 'network';
  if (status === 401) return 'unauthenticated';
  if (status === 200) return 'shape';
  return status >= 500 ? 'server' : 'refused';
}

// `trees` reads the person's roadmaps (`list`) and the roadmap an address names (`read`). `attachment(complete)` says
// what attaching a tree, complete or not, does to a hand's mark on the step. `onAttach(row)` sets the tree and answers
// whether the picker is done; `onLapse` tells the room a read was refused for want of a session.
export function TreePicker({ step, treeId, standing, attachment, trees, layout, headingId, band, view, onAttach, onLapse, onCancel }) {
  const phone = layout === 'phone';
  const layer = useRef(null);
  const region = useRef(null);
  const search = useRef(null);
  const rowList = useRef(null);
  const reported = useRef(new Set());
  const resolutions = useRef(new Map());
  const counted = useRef(new Set());
  const pasting = useRef(false);
  const committed = useRef(false);
  const [choices, setChoices] = useState(null);
  const [listFailure, setListFailure] = useState(null);
  const [listAttempt, setListAttempt] = useState(0);
  const [settled, setSettled] = useState(null);
  const [addressAttempt, setAddressAttempt] = useState(0);
  const [forking, setForking] = useState(false);
  const viewport = useComposerViewport(phone);
  const trapTab = useComposerFocus(region, phone, { restore: false });

  useLayoutEffect(() => (phone ? coverBeneath(layer.current) : undefined), [phone]);

  useLayoutEffect(() => {
    if (!phone) search.current.focus({ preventScroll: true });
  }, [phone]);

  // A read refused for want of a session is the room's lapse. Anything else reports once per read and reason while the
  // fault is ours or the server's: a lost request only while someone waits on it, and a refusal never.
  const readFailed = (read, reason) => {
    if (reason === 'unauthenticated') {
      onLapse?.();
      return;
    }
    const key = `${read} ${reason}`;
    if (reason === 'refused' || (reason === 'network' && !pageWatching()) || reported.current.has(key)) return;
    reported.current.add(key);
    reportRoadmapFailure('roadmap-tree-picker-load', new Error('Roadmap tree picker read failed'), { read, reason });
  };
  // One `paste` event for each roadmap an address resolved to.
  const countPaste = (id, outcome) => {
    if (counted.current.has(id)) return;
    counted.current.add(id);
    track('roadmap_tree_attach', { step: 'paste', outcome, band, view });
  };

  useEffect(() => {
    let wanted = true;
    trees.list().then(({ rows, authoritative, status }) => {
      if (!wanted) return;
      if (!authoritative) {
        readFailed('list', failureOf(status));
        setListFailure(failureOf(status));
        return;
      }
      setListFailure(null);
      const others = rows.filter((row) => row.id !== treeId)
        .map((row) => ({ id: row.id, title: row.title?.trim() || t('roadmap.common.untitled'), done: row.done ?? 0, total: row.total ?? 0 }));
      setChoices((current) => (current ? current.listed(others) : new TreeChoices({ rows: others, standing })));
    });
    return () => { wanted = false; };
  }, [listAttempt]);

  // An address is read once the field has been still, at once when it was pasted, and once for each roadmap it names.
  const address = choices?.address ?? null;
  useEffect(() => {
    if (address === null) {
      setSettled(null);
      return undefined;
    }
    if (settled === address) return undefined;
    const timer = setTimeout(() => setSettled(address), ADDRESS_STILL_MS);
    return () => clearTimeout(timer);
  }, [address, settled]);

  useEffect(() => {
    if (settled === null) return undefined;
    if (choices?.rows.some((row) => row.id === settled)) {
      countPaste(settled, 'own');
      return undefined;
    }
    const answered = (pasted) => setChoices((current) => (current?.address === settled ? current.resolved(pasted) : current));
    const known = resolutions.current.get(settled);
    if (known) {
      answered(known);
      return undefined;
    }
    let wanted = true;
    trees.read(settled).then((card) => ({ id: settled, card }), (error) => ({ id: settled, failed: true, reason: failureOf(error?.status ?? 0) }))
      .then((pasted) => {
        if (!pasted.failed) resolutions.current.set(settled, pasted);
        if (!wanted) return;
        if (pasted.failed) readFailed('paste', pasted.reason);
        else countPaste(settled, pasted.card === null ? 'unreadable' : pasted.card.mine ? 'own' : 'readable');
        answered(pasted);
      });
    return () => { wanted = false; };
  }, [settled, addressAttempt]);

  const blocked = choices?.blocked ?? null;
  const listed = choices !== null && listFailure === null;
  const addressFailed = listed && choices.failed;
  const mark = listed && !blocked && !addressFailed && choices.rows.length > 0
    ? attachment(Boolean(choices.chosenRow) && choices.chosenRow.total > 0 && choices.chosenRow.done === choices.chosenRow.total)
    : null;
  const known = listed && !choices.unresolved && !addressFailed;
  const context = known && choices.searched
    ? t('roadmap.treePicker.forMatches', { step, count: choices.count, shown: formatCount(choices.count) })
    : known && choices.rows.length > 0
      ? t('roadmap.treePicker.forTrees', { step, count: choices.rows.length, shown: formatCount(choices.rows.length) })
      : pickerFor({ step, total: null });
  const unmatched = known && choices.searched && choices.count === 0 && choices.outcome !== 'unreadable';
  const tabStop = choices?.shown.find((row) => row.id === choices.chosen)?.id ?? choices?.shown[0]?.id ?? null;

  const narrow = (query) => {
    if (!choices) return;
    const next = choices.search(query);
    if (pasting.current && next.address) setSettled(next.address);
    pasting.current = false;
    setChoices(next);
  };
  const clear = () => {
    setChoices(choices.search(''));
    search.current.focus();
  };
  const retry = (read) => {
    track('roadmap_tree_attach', { step: 'retry', read, band, view });
    if (read === 'paste') {
      setChoices(choices.resolved(null));
      setAddressAttempt((count) => count + 1);
    } else {
      setListAttempt((count) => count + 1);
    }
    (phone ? region : search).current.focus({ preventScroll: true });
  };
  const attach = () => {
    if (committed.current) return;
    committed.current = onAttach(choices.chosenRow);
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
      onChange={narrow} onClear={clear} onPaste={() => { pasting.current = true; }} />
  );
  const commit = blocked
    ? <button type="button" className="st-board-step-action st-board-step-action--primary" onClick={fork}>{t('roadmap.treePicker.forkTree')}</button>
    : <button type="button" className="st-board-step-action st-board-step-action--primary" disabled={!listed || !choices.attachable} onClick={attach}>{t('roadmap.treePicker.attach')}</button>;
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
        {listFailure !== null && (
          <div className="st-board-tree-picker-unread" role="alert">
            <p>{t('roadmap.treePicker.loadFailed')}</p>
            {listFailure !== 'unauthenticated' && <Button variant="secondary" onClick={() => retry('list')}>{LOAD_ERROR.action}</Button>}
          </div>
        )}
        {addressFailed && (
          <div className="st-board-tree-picker-unread" role="alert">
            <p>{LOAD_ERROR.title}</p>
            {choices.pasted.reason !== 'unauthenticated' && <Button variant="secondary" onClick={() => retry('paste')}>{LOAD_ERROR.action}</Button>}
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
        {mark?.marked && !unmatched && choices.outcome !== 'unreadable' && !choices.unresolved && (
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
            setListAttempt((count) => count + 1);
            (phone ? region : search).current.focus({ preventScroll: true });
          }} />
      )}
    </div>
  );
  if (!phone) return page;
  return createPortal(<div ref={layer} style={viewport.style} className="st-board-composer-layer is-phone">{page}</div>, document.body);
}
