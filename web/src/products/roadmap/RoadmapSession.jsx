// Roadmap's session where the room reads the device's copy (routes.session): above every room, the step draft that outlives
// its view, and beside every room the one list of what cannot land, which the account menu opens (§6, flow 49). On every
// load it carries what roadmap's old bundle kept in this browser into the replica (§8.2).

import React, { useEffect } from 'react';
import { StepDraftProvider } from './step/StepDraftProvider.jsx';
import { KeptHere } from './kept/KeptHere.jsx';
import { CarryOver } from './carry/CarryOver.js';

export function RoadmapSession({ dataScope, children }) {
  useEffect(() => {
    const carry = new CarryOver();
    carry.start();
    return () => carry.stop();
  }, []);
  return <StepDraftProvider dataScope={dataScope}>{children}<KeptHere /></StepDraftProvider>;
}
