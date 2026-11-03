import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Compass, Download, GitFork, Keyboard, MoreHorizontal, Settings, Share, Sparkles } from 'lucide-react';
import { Tooltip } from '../../../design-system';
import { track } from '../../../telemetry/beacon.js';
import { hueOf } from '../theme.js';
import { TreeSwitcher } from '../ui/TreeSwitcher.jsx';
import { FindStep, NewStep, handleMenuKey, dismissOverlayOutside } from './BoardControls.jsx';
import { ActivityIcon, RoadmapSheet } from './RoadmapSheet.jsx';
import { ViewSwitch } from './ViewSwitch.jsx';
import { countBucket } from './acts.js';
import { DEMO_BYLINE, LABELS, ROADMAP_VERBS, formatCount, nextChip, progressFigure, progressLabel, reasonLine, upNextCount } from './copy.js';
import './identity.css';

const FULL_DESKTOP_QUERY = '(min-width: 1280px)';

export function RoadmapIdentity({
  band, view, role, title, switcher, progress, onSwitchView, find, next,
  onAskAI, onShare, onNewStep, onExport, onSettings, onShortcuts, onFork, sheet, onBottom, onActivity,
}) {
  const bar = useRef(null);
  const titleButton = useRef(null);
  const moreButton = useRef(null);
  const nextButton = useRef(null);
  const moreBox = useRef(null);
  const nextBox = useRef(null);
  const [fullDesktop, setFullDesktop] = useState(() => typeof window !== 'undefined' && window.matchMedia(FULL_DESKTOP_QUERY).matches);
  const [overlay, setOverlay] = useState(null);
  const phone = band === 'phone';
  const owner = role === 'owner';
  const tablet = band === 'tablet';
  const desktop = band === 'desktop';
  const context = `${band}:${view}:${role}`;
  const nextAvailable = !phone && owner && view === 'tree' && next?.count > 0;
  const sheetAvailable = phone && owner && sheet !== null && sheet !== undefined && title !== undefined;
  const menuItems = [
    ...(tablet ? [
      { verb: 'askAI', label: ROADMAP_VERBS.askAI, icon: Sparkles, key: '⌘K', act: onAskAI },
      { verb: 'share', label: ROADMAP_VERBS.shareRoadmap, icon: Share, act: onShare },
    ] : []),
    { verb: 'activity', label: ROADMAP_VERBS.activity, icon: ActivityIcon, key: 'A', act: onActivity },
    { verb: 'export', label: ROADMAP_VERBS.export, icon: Download, act: onExport },
    { verb: 'settings', label: ROADMAP_VERBS.settings, icon: Settings, act: onSettings },
    { verb: 'shortcuts', label: ROADMAP_VERBS.keyboardShortcuts, icon: Keyboard, key: '?', act: onShortcuts },
  ].filter((item) => item.act);
  const moreAvailable = !phone && owner && menuItems.length > 0;
  const available = { more: moreAvailable, next: nextAvailable, sheet: sheetAvailable };
  const open = overlay?.context === context && available[overlay.kind] ? overlay.kind : null;

  useEffect(() => {
    const media = window.matchMedia(FULL_DESKTOP_QUERY);
    const change = () => setFullDesktop(media.matches);
    change();
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);

  useLayoutEffect(() => {
    if (!onBottom) return undefined;
    const report = () => onBottom(bar.current.offsetTop + bar.current.offsetHeight);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(bar.current, { box: 'border-box' });
    window.addEventListener('resize', report);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
    };
  }, [onBottom]);

  useLayoutEffect(() => {
    if (!overlay || open) return;
    if (overlay.kind === 'next') track('roadmap_whats_next', { step: 'close', count: countBucket(overlay.count) });
    setOverlay(null);
    if (document.activeElement === document.body) {
      const title = titleButton.current;
      const selectedView = bar.current.querySelector('[aria-pressed="true"]');
      const firstControl = bar.current.querySelector('button, input');
      if (title) {
        title.focus();
        return;
      }
      if (selectedView) {
        selectedView.focus();
        return;
      }
      (firstControl ?? bar.current).focus();
    }
  }, [overlay, open]);

  const verb = (name, door = 'row') => track('roadmap_verb', {
    verb: name, door, view: view === 'tree' ? 'graph' : 'board', band,
  });
  const close = useCallback((outcome = 'close', restoreFocus = true) => {
    if (overlay?.kind === 'next') track('roadmap_whats_next', { step: outcome, count: countBucket(overlay.count) });
    flushSync(() => setOverlay(null));
    if (!restoreFocus) return;
    const triggers = { sheet: titleButton, more: moreButton, next: nextButton };
    triggers[overlay?.kind]?.current?.focus();
  }, [overlay]);
  const leaveOverlay = useCallback((event) => {
    const root = open === 'more' ? moreBox.current : nextBox.current;
    if (!open || event.currentTarget !== root || root.contains(event.relatedTarget)) return;
    close('close', false);
  }, [open, close]);

  useEffect(() => {
    if (open !== 'more' && open !== 'next') return undefined;
    const box = open === 'more' ? moreBox : nextBox;
    const away = (event) => dismissOverlayOutside(event, box.current, close);
    const escape = (event) => {
      if (open !== 'next' || event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', escape);
    };
  }, [open, close]);

  useLayoutEffect(() => {
    if (open === 'more') moreBox.current.querySelector('[role="menuitem"]')?.focus();
    if (open === 'next') nextBox.current.querySelector('.st-roadmap-next-card')?.focus();
  }, [open]);

  const toggle = (kind) => {
    if (open === kind) {
      close();
      return;
    }
    if (kind === 'sheet') track('roadmap_sheet', { step: 'open' });
    else verb(kind);
    if (kind === 'next') track('roadmap_whats_next', { step: 'open', count: countBucket(next.count) });
    setOverlay({ kind, context, ...(kind === 'next' ? { count: next.count } : {}) });
  };

  const showSwitcher = title !== undefined && !sheetAvailable && !phone && owner && !!switcher;
  const showHeading = title !== undefined && !sheetAvailable && !showSwitcher;
  const identitySwitcher = React.isValidElement(switcher) && switcher.type === TreeSwitcher
    ? React.cloneElement(switcher, { variant: 'identity' })
    : switcher;

  return (
    <div
      ref={bar}
      tabIndex={-1}
      className={`st-roadmap-identity st-roadmap-identity--${band}${!phone && !fullDesktop ? ' st-roadmap-identity--folded' : ''}`}
      data-role={role}
      data-view={view}
    >
      {role === 'demo' && phone && <span className="st-roadmap-sample">{DEMO_BYLINE.phone}</span>}
      <div className="st-roadmap-context">
        {sheetAvailable && (
          <button ref={titleButton} className="st-roadmap-title st-roadmap-title-button" type="button"
            aria-label={title} aria-haspopup="dialog" aria-expanded={open === 'sheet'} onClick={() => toggle('sheet')}>
            {title}
          </button>
        )}
        {showSwitcher && <div className="st-roadmap-switcher">{identitySwitcher}</div>}
        {showHeading && <h1 ref={titleButton} tabIndex={-1} className="st-roadmap-title" title={title}>{title}</h1>}
      </div>
      {role === 'demo' && !phone && <span className="st-roadmap-sample">{DEMO_BYLINE.wide}</span>}
      {title !== undefined && progress && (
        <span className="st-roadmap-progress" aria-label={progressLabel(progress)}>
          {progressFigure({ ...progress, compact: phone })}
        </span>
      )}
      {onSwitchView && <ViewSwitch view={view} onSwitch={onSwitchView} phone={phone} />}
      {!phone && <>
        <div className="st-roadmap-space" />
        {find && <FindStep {...find} folded={!fullDesktop} tooltip={desktop} onExpand={() => verb('find')} />}
        {owner && !tablet && onAskAI && (
          <RowButton
            tooltip={desktop}
            label={ROADMAP_VERBS.askAI}
            icon={Sparkles}
            expanded={fullDesktop}
            keycap={fullDesktop ? '⌘K' : null}
            brand
            onClick={() => {
              verb('askAI');
              onAskAI();
            }}
          />
        )}
        {nextAvailable && <div ref={nextBox} className="st-roadmap-popover-anchor" onBlur={leaveOverlay}>
          <Tooltip label={nextChip(next)} side="bottom" disabled={!desktop || open === 'next'}>
            <button
              ref={nextButton}
              type="button"
              className="st-roadmap-chip"
              aria-label={nextChip(next)}
              aria-expanded={open === 'next'}
              aria-haspopup="dialog"
              onClick={() => toggle('next')}
            >
              <Compass size={20} aria-hidden />
              <span>{tablet ? formatCount(next.count) : nextChip(next)}</span>
            </button>
          </Tooltip>
          {open === 'next' && <div className="st-roadmap-next" role="dialog" aria-label={upNextCount(next)}>
            <h2>{upNextCount(next)}</h2>
            <div className="st-roadmap-next-list" tabIndex={-1}>
              {next.cards.map((card) => {
                const reason = reasonLine(card);
                const kind = hueOf(card.step.color);
                return (
                  <button
                    key={card.id}
                    className="st-roadmap-next-card"
                    type="button"
                    style={{ '--roadmap-kind': kind.base }}
                    onClick={() => {
                      close('pick');
                      next.onOpen(card.id);
                    }}
                  >
                    <span className="st-roadmap-next-rail" aria-hidden />
                    <span className="st-roadmap-next-content">
                      <span className="st-roadmap-next-title">{card.step.label}</span>
                      {reason && <span className="st-roadmap-next-reason">{reason}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>}
        </div>}
        {(!owner || !tablet) && onShare && (
          <RowButton tooltip={desktop} label={ROADMAP_VERBS.share} icon={Share} onClick={() => {
            verb('share');
            onShare();
          }} />
        )}
        {owner && onNewStep && (
          <Tooltip label={LABELS.newStep} side="bottom" disabled={!desktop}>
            <NewStep compact={tablet} onClick={() => {
              verb('newStep');
              onNewStep();
            }} />
          </Tooltip>
        )}
        {!owner && onFork && (
          <RowButton tooltip={desktop} label={ROADMAP_VERBS.fork} icon={GitFork} expanded primary onClick={() => {
            verb('fork');
            onFork();
          }} />
        )}
        {moreAvailable && <div ref={moreBox} className="st-roadmap-popover-anchor" onBlur={leaveOverlay}>
          <Tooltip label={ROADMAP_VERBS.more} side="bottom" disabled={!desktop || open === 'more'}>
            <button
              ref={moreButton}
              type="button"
              className="st-roadmap-icon"
              aria-label={ROADMAP_VERBS.more}
              aria-haspopup="menu"
              aria-expanded={open === 'more'}
              onClick={() => toggle('more')}
            >
              <MoreHorizontal size={20} aria-hidden />
            </button>
          </Tooltip>
          {open === 'more' && <div
            className="st-roadmap-menu"
            role="menu"
            aria-label={ROADMAP_VERBS.more}
            onKeyDown={(event) => handleMenuKey(event, {
              root: moreBox.current, onEscape: close, onTab: close,
            })}
          >
            {menuItems.map((item) => (
              <button key={item.verb} type="button" role="menuitem" onClick={() => {
                verb(item.verb, 'more');
                close();
                item.act();
              }}>
                <item.icon size={20} aria-hidden />
                <span>{item.label}</span>
                {item.key && <kbd className="st-board-keycap" aria-hidden>{item.key}</kbd>}
              </button>
            ))}
          </div>}
        </div>}
      </>}
      {open === 'sheet' && (
        <RoadmapSheet
          sheet={sheet}
          view={view}
          band={band}
          onAskAI={onAskAI}
          onShare={onShare}
          onExport={onExport}
          onSettings={onSettings}
          onActivity={onActivity}
          onClose={close}
        />
      )}
    </div>
  );
}

function RowButton({ label, tooltip, icon: Icon, expanded = false, primary = false, brand = false, keycap, onClick }) {
  const classes = [expanded ? 'st-roadmap-chip' : 'st-roadmap-icon'];
  if (primary) classes.push('st-roadmap-fork');
  if (brand) classes.push('st-roadmap-ask');
  return (
    <Tooltip label={label} side="bottom" disabled={!tooltip}>
      <button type="button" className={classes.join(' ')} aria-label={label} onClick={onClick}>
        <Icon size={20} aria-hidden />
        {expanded && <span>{label}</span>}
        {keycap && <kbd className="st-board-keycap" aria-hidden>{keycap}</kbd>}
      </button>
    </Tooltip>
  );
}
