// Roadmap's session where the room reads the device's copy (routes.session): above every room, the step draft that outlives
// its view, and beside every room the one list of what cannot land, which the account menu opens (§6, flow 49).

import React from 'react';
import { StepDraftProvider } from './step/StepDraftProvider.jsx';
import { KeptHere } from './kept/KeptHere.jsx';

export function RoadmapSession({ dataScope, children }) {
  return <StepDraftProvider dataScope={dataScope}>{children}<KeptHere /></StepDraftProvider>;
}
