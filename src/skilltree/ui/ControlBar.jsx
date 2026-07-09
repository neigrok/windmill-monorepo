// Top overlay bar: the Windmill wordmark + a way back to the component
// showcase on the left, dataset size + camera controls on the right.

import React from 'react';
import { IconButton, Tabs, Tooltip, Icon } from '../../components';

const DATASET_OPTIONS = [
  { value: 'demo', label: 'Demo' },
  { value: 'huge', label: 'Huge (5k)' },
];

export function ControlBar({ title, datasetSize, onDatasetSizeChange, onZoomIn, onZoomOut, onFitToView }) {
  return (
    <div className="st-topbar">
      <div className="st-brand">
        <span className="st-brand-mark">
          <Icon name="sprout" size={18} />
        </span>
        <div className="st-brand-text">
          <span className="st-brand-name">Windmill</span>
          {title && <span className="st-brand-title">{title}</span>}
        </div>
        <Tooltip label="Component showcase" side="bottom">
          <a className="st-showcase-link" href="#/showcase">
            <Icon name="external-link" size={14} />
          </a>
        </Tooltip>
      </div>

      <div className="st-controls">
        <Tabs tabs={DATASET_OPTIONS} value={datasetSize} onChange={onDatasetSizeChange} />
        <div className="st-zoom-group">
          <Tooltip label="Zoom out" side="bottom">
            <IconButton icon={<Icon name="zoom-out" />} label="Zoom out" size="sm" onClick={onZoomOut} />
          </Tooltip>
          <Tooltip label="Zoom in" side="bottom">
            <IconButton icon={<Icon name="zoom-in" />} label="Zoom in" size="sm" onClick={onZoomIn} />
          </Tooltip>
          <Tooltip label="Fit to view" side="bottom">
            <IconButton icon={<Icon name="maximize" />} label="Fit to view" size="sm" onClick={onFitToView} />
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
