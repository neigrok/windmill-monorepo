import React, { useLayoutEffect, useRef, useState } from 'react';

// A bottom sheet: a modal <dialog> in the browser's top layer, so it and its scrim (`::backdrop`) cover every header and
// frame of the page, whatever contains the room that opens it, with the grabber at its head. Escape, a press on the scrim
// and a close the browser makes itself all close it through `onClose`; closing hands focus back to what held it before.
// A close the browser queued before the dialog opened again, as React's StrictMode closes and reopens it in development,
// closes nothing. Its content mounts once the dialog is open, so a field in it that takes focus as it mounts has it.
// `label` names it for a screen reader and `className` dresses its body. `detent` is how far it rises: `medium` to its content, and no higher
// than most of the viewport, or `large`, the viewport but a band at its top, its body filling the sheet. Styled by
// `.wm-sheet-*` in styles/global.css.
export function Sheet({ label, onClose, className = '', detent = 'medium', children }) {
  const dialog = useRef(null);
  const closing = useRef(false);
  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const node = dialog.current;
    closing.current = false;
    if (typeof node.showModal === 'function') node.showModal();
    else node.setAttribute('open', '');
    setOpen(true);
    return () => {
      closing.current = true;
      if (node.open && typeof node.close === 'function') node.close();
    };
  }, []);

  return (
    <dialog ref={dialog} className={detent === 'large' ? 'wm-sheet is-large' : 'wm-sheet'} aria-label={label}
      onCancel={(event) => { event.preventDefault(); latestClose.current(); }}
      onClose={() => { if (!closing.current && !dialog.current?.open) latestClose.current(); }}
      onClick={(event) => { if (event.target === event.currentTarget) latestClose.current(); }}>
      <div className={`wm-sheet-body${className ? ` ${className}` : ''}`}>
        <span className="wm-sheet-grabber" aria-hidden="true" />
        {open && children}
      </div>
    </dialog>
  );
}
