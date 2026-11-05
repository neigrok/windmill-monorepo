import { useLayoutEffect } from 'react';

export function dismissOverlayOutside(event, root, onClose) {
  if (root?.contains(event.target)) return;
  event.preventDefault();
  onClose();
}

export function usePopoverDismissal({ open, root, onClose, restoreOutsideFocus = true }) {
  useLayoutEffect(() => {
    const box = root.current;
    if (!open || !box) return undefined;
    const document = box.ownerDocument;
    let listening = true;
    let insidePress = false;
    let pressEnd;
    const press = (event) => {
      clearTimeout(pressEnd);
      insidePress = box.contains(event.target);
      pressEnd = setTimeout(() => { insidePress = false; }, 0);
      if (event.type !== 'pointerdown' || insidePress) return;
      if (restoreOutsideFocus) {
        // WebKit still sends a finger press its mousedown after pointerdown is cancelled; that mousedown would take focus off the restored trigger.
        const holdFocus = (next) => {
          if (next.type === 'mousedown') next.preventDefault();
          document.removeEventListener('mousedown', holdFocus, true);
          document.removeEventListener('pointerdown', holdFocus, true);
        };
        document.addEventListener('mousedown', holdFocus, true);
        document.addEventListener('pointerdown', holdFocus, true);
        dismissOverlayOutside(event, box, onClose);
        return;
      }
      onClose('close', false);
    };
    const focus = (event) => {
      if (box.contains(event.target)) return;
      // Safari may focus the containing surface while pressing a button inside the popover.
      if (insidePress && event.target.contains(box)) return;
      onClose('close', false);
    };
    const leave = (event) => {
      if (event.relatedTarget || insidePress) return;
      // Chromium also blurs a focused node React removes mid-commit; only a node still on the page lost focus to nowhere.
      queueMicrotask(() => { if (listening && event.target.isConnected) onClose('close', false); });
    };
    const key = (event) => {
      insidePress = false;
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('pointerdown', press, true);
    document.addEventListener('mousedown', press, true);
    document.addEventListener('focusin', focus, true);
    document.addEventListener('focusout', leave, true);
    document.addEventListener('keydown', key, true);
    return () => {
      listening = false;
      clearTimeout(pressEnd);
      document.removeEventListener('pointerdown', press, true);
      document.removeEventListener('mousedown', press, true);
      document.removeEventListener('focusin', focus, true);
      document.removeEventListener('focusout', leave, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [open, root, onClose, restoreOutsideFocus]);
}
