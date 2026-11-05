import { useEffect } from 'react';

export function dismissOverlayOutside(event, root, onClose) {
  if (root?.contains(event.target)) return;
  event.preventDefault();
  onClose();
}

export function usePopoverDismissal({ open, root, onClose, restoreOutsideFocus = true }) {
  useEffect(() => {
    const box = root.current;
    if (!open || !box) return undefined;
    const document = box.ownerDocument;
    let insidePress = false;
    let pressEnd;
    const press = (event) => {
      clearTimeout(pressEnd);
      insidePress = box.contains(event.target);
      pressEnd = setTimeout(() => { insidePress = false; }, 0);
      if (event.type !== 'pointerdown' || insidePress) return;
      if (restoreOutsideFocus) {
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
    document.addEventListener('keydown', key, true);
    return () => {
      clearTimeout(pressEnd);
      document.removeEventListener('pointerdown', press, true);
      document.removeEventListener('mousedown', press, true);
      document.removeEventListener('focusin', focus, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [open, root, onClose, restoreOutsideFocus]);
}
