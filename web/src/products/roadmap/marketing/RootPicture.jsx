// Roadmap's picture on the brand root: the request and the tree it became, on the stage the shell names.

import React from 'react';
import { Icon } from '../../../design-system';
import { ComposedTree, SAIL_NARROW, SAIL_WIDE } from './ComposedTree.jsx';
import { t } from '../i18n/entry/index.js';
import './roadmapRootPicture.css';

export function RoadmapPicture({ stage }) {
  return (
    <div className="rmPicture" data-stage={stage}>
      <div className="rmPicture-request">
        <span className="rmPicture-label">{t('roadmap.root.request')}</span>
        <span className="rmPicture-bubble">{t('roadmap.root.requestText')}</span>
      </div>
      <span className="rmPicture-arrow"><Icon name="arrow-right" size={20} strokeWidth={1.6} /></span>
      <ComposedTree world={stage === 'narrow' ? SAIL_NARROW : SAIL_WIDE} />
    </div>
  );
}
