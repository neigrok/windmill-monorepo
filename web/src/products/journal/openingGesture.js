// Who owns the scroll while the canvas is opening.
//
// The canvas opens ON tonight and keeps re-taking that position while the page is still being laid
// out — the room's height settles, the account's window lands above tonight, the webfonts swap and
// re-flow every line, an echo tab appears and re-wraps the page it hangs off. Until the writer says
// otherwise, every one of those has to be corrected.
//
// So the opening ends on a GESTURE and never on a scroll event. A scroll event cannot say who
// caused it: Chrome scrolls this canvas itself — anchoring compensation, a clamp when the content
// above the viewport shrinks, its own restoration on reload — and reading one of those as the
// writer taking the scroll forfeits the position permanently, which is how a journal opens in the
// middle of July. An input is unambiguous: nobody but the writer makes one.
//
// Pure, over the plain fields of an event, so the rule can be read and tested without a DOM.

// The page keys scroll the canvas even while the composer holds the focus — the field autosizes, so
// it has no scrolling of its own to spend them on. The rest only move a caret while it is focused.
export const PAGE_KEYS = ['PageUp', 'PageDown'];
export const CARET_KEYS = ['ArrowUp', 'ArrowDown', 'Home', 'End', ' '];

export function writerTookTheScroll({ type, key = null, insideField = false }) {
  if (type === 'wheel' || type === 'touchstart') return true;   // a drag over the composer still moves the canvas
  if (type === 'keydown') return PAGE_KEYS.includes(key) || (!insideField && CARET_KEYS.includes(key));
  // A press anywhere on the canvas: a scrollbar drag, a selection drag, the press that opens an echo
  // tab. Inside the composer it only places a caret, at the foot, where the canvas already is.
  if (type === 'pointerdown') return !insideField;
  return false;
}
