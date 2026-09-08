// The roadmap's two stills on the brand root: the hero glimpse and the section illustration.

import React from 'react';
import { useScene } from '../../../shell/marketing/LandingChrome.jsx';
import { mountGlimpse, mountSectionTree } from './treeScenes.js';
import './roadmapLanding.css';

export function RoadmapGlimpse() {
  const ref = useScene(mountGlimpse);
  return (
    <figure className="rootGlimpse">
      <div className="rootGlimpseStage" aria-hidden="true"><div ref={ref}></div></div>
      <figcaption className="composed">Composed tree</figcaption>
    </figure>
  );
}

export function RoadmapIllustration() {
  const ref = useScene(mountSectionTree);
  return (
    <figure className="rootTreeCard">
      <div className="plq plq--card in" aria-hidden="true">
        <span className="kdot"></span>
        <span>
          <div className="tn">Learn to sail</div>
          <div className="by"><b>Windmill demo</b> · <span className="ct">6</span>/17 done</div>
        </span>
      </div>
      <div className="rootTreeStage" aria-hidden="true"><div ref={ref}></div></div>
      <figcaption className="composed">Composed tree</figcaption>
    </figure>
  );
}
