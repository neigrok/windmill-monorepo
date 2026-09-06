// The landing nav's Light · Dark bar — the one place appearance is chosen on a marketing page. The
// checked segment is the RESOLVED appearance, so with nothing stored it reads the system's side and
// moves with a system flip; a pick stores an explicit choice. There is no System segment here: the
// way back to following the device lives in the app's seat. Under 480px the word hides and the
// icon stands alone, `ariaLabel` keeping the name.

import React from 'react';
import { SegmentedControl } from '../../design-system';
import { useAppearance } from '../useAppearance.js';

const OPTIONS = [
  { value: 'light', label: <span className="landing-appearance-word">Light</span>, ariaLabel: 'Light', icon: 'sun' },
  { value: 'dark', label: <span className="landing-appearance-word">Dark</span>, ariaLabel: 'Dark', icon: 'moon' },
];

export function AppearanceToggle() {
  const { resolved, set } = useAppearance();
  return (
    <div className="landing-appearance">
      <SegmentedControl label="Appearance" options={OPTIONS} value={resolved} onChange={set} />
    </div>
  );
}

export default AppearanceToggle;
