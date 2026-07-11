// Compact overlay badge: a tidiness score for the dependency graph,
// with counts of cross-area and redundant dependencies.

import React from 'react';
import { Icon, Tooltip } from '../../components';

export function TidinessBadge({ health }) {
  if (!health) return null;

  const tier = health.score >= 80 ? 'st-tidiness--good'
    : health.score >= 55 ? 'st-tidiness--ok'
    : 'st-tidiness--poor';

  return (
    <div className={`st-tidiness ${tier}`}>
      <div className="st-tidiness-score">
        {health.score}
        <span className="st-tidiness-label">Tidiness</span>
      </div>
      <div className="st-tidiness-detail">
        <Tooltip label="Dependencies that cross between areas" side="bottom">
          <span className="st-tidiness-stat">
            <Icon name="fan" size={12} />
            {health.crossBranch}
          </span>
        </Tooltip>
        <Tooltip label="Redundant, already-implied dependencies" side="bottom">
          <span className="st-tidiness-stat">
            <Icon name="frame" size={12} />
            {health.redundant}
          </span>
        </Tooltip>
      </div>
    </div>
  );
}
