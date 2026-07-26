// Notes — scaffold. A placeholder surface so the product slot exists and the shell's
// compose + switcher pattern has a real second entry to mount. The daily-notes product
// lands here later; for now it states its intent and offers the switcher back out.

import React from 'react';
import { ProductSwitcher } from '../../shell/ProductSwitcher.jsx';
import { ComingSoon } from '../../shell/ComingSoon.jsx';

export function NotesApp() {
  return (
    <ComingSoon title="Notes" blurb="Daily notes, woven into the same superapp. Coming soon.">
      <ProductSwitcher current="notes" />
    </ComingSoon>
  );
}

export default NotesApp;
