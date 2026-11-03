const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [contenteditable], [tabindex]';

export function focusableElements(root) {
  if (!root) return [];
  return [...root.querySelectorAll(FOCUSABLE)].filter((element) => (
    element.tabIndex >= 0
    && !element.matches(':disabled')
    && !element.closest('[inert]')
    && element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== 'hidden'
  ));
}

export function wrapTab(event, root) {
  if (event.key !== 'Tab' || event.defaultPrevented || !root) return;
  event.stopPropagation();
  const stops = focusableElements(root);
  const current = document.activeElement;
  const edge = event.shiftKey ? stops[0] : stops.at(-1);
  if (stops.includes(current) && current !== edge) return;
  event.preventDefault();
  const target = event.shiftKey ? stops.at(-1) : stops[0];
  (target ?? root).focus();
}
