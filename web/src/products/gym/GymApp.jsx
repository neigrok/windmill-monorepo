// Gym — scaffold. A placeholder surface so the product slot exists and the shell's compose
// + switcher pattern has a real third entry. The training-log product lands here later.

import React from 'react';
import { ProductSwitcher } from '../../shell/ProductSwitcher.jsx';
import { ComingSoon } from '../../shell/ComingSoon.jsx';

export function GymApp() {
  return (
    <ComingSoon title="Gym" blurb="A training log for the body, in the same superapp. Coming soon.">
      <ProductSwitcher current="gym" />
    </ComingSoon>
  );
}

export default GymApp;
