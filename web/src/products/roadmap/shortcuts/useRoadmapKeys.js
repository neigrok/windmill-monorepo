import { useEffect, useRef } from 'react';
import { track } from '../../../telemetry/beacon.js';
import { boardKey, graphOnlyKey } from './shortcutMap.js';

const isField = (element) => element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA');
const isTyping = (element) => isField(element) || Boolean(element?.isContentEditable);
const modified = (event) => event.metaKey || event.ctrlKey;

// `room` is the room as it stands: what covers it, what it holds and what it can do.
export function handleRoomKey(event, room) {
  if (room.canTend) {
    if (event.key === 'Escape' && room.tendOpen) {
      event.preventDefault();
      room.setTendOpen(false);
      return;
    }
    if (!room.covered() && event.key.toLowerCase() === 'k' && modified(event)) {
      event.preventDefault();
      if (!room.tendOpen) track('roadmap_verb', { verb: 'askAI', door: 'key', view: room.boardActive ? 'board' : 'graph', band: room.band });
      room.setTendOpen((open) => !open);
      return;
    }
  }
  if (event.defaultPrevented) return;

  const covered = room.covered();
  const typing = isTyping(document.activeElement);
  const boardAction = boardKey(event, { typing, covered });
  if (boardAction === 'activity') {
    if (!room.activityEnabled) return;
    event.preventDefault();
    room.openActivity('key');
    return;
  }
  if (room.boardActive && graphOnlyKey(event)) {
    if (modified(event) && event.key.toLowerCase() === 'a' && !typing) event.preventDefault();
    return;
  }
  if (room.desktopEditor && modified(event) && event.key.toLowerCase() === 'z') {
    if (covered) return;
    event.preventDefault();
    track('roadmap_board_undo', { act: event.shiftKey ? 'redoKey' : 'undoKey' });
    if (event.shiftKey) room.redo();
    else room.undo();
    return;
  }
  if (room.desktopEditor && modified(event) && event.key.toLowerCase() === 'a') {
    if (typing) return;
    event.preventDefault();
    room.selectEveryStep();
    return;
  }
  if (event.key === 'Escape') {
    if (!covered) room.stepBack();
    return;
  }
  const plainKey = !modified(event) && !event.altKey && !typing;
  if (boardAction === 'find') {
    if (room.focusFind()) event.preventDefault();
    return;
  }
  if (boardAction === 'switch' && room.switchViews) {
    event.preventDefault();
    room.switchViews();
    return;
  }
  if (event.key.toLowerCase() === 'f' && plainKey) {
    event.preventDefault();
    room.focusCamera();
    return;
  }
  if (event.key === '0' && plainKey) {
    event.preventDefault();
    room.showAllSteps();
    return;
  }
  if (event.key === '?' && !modified(event) && !event.altKey) {
    if (covered || typing) return;
    event.preventDefault();
    room.toggleShortcuts();
    return;
  }
  if (room.desktopEditor && (event.key === 'Backspace' || event.key === 'Delete') && !isField(document.activeElement) && room.deleteSelection()) {
    event.preventDefault();
  }
}

export function handleRoomPaste(event, room) {
  if (!room.desktopEditor || room.covered() || isTyping(document.activeElement)) return;
  const pasted = event.clipboardData?.getData('text/plain') ?? '';
  if (pasted.trim() === '') return;
  event.preventDefault();
  room.openComposer(pasted);
  track('roadmap_board_create', { step: 'open', door: 'paste', view: 'graph' });
}

// The room's window-level keys: Ask AI, the editor's chords, the Board's letters and pasted plans.
export function useRoadmapKeys(room) {
  const latest = useRef(room);
  latest.current = room;
  useEffect(() => {
    const onKey = (event) => handleRoomKey(event, latest.current);
    const onPaste = (event) => handleRoomPaste(event, latest.current);
    window.addEventListener('keydown', onKey);
    window.addEventListener('paste', onPaste, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('paste', onPaste, true);
    };
  }, []);
}
