// NEXT UP — the "what's next" section that leads the activity dock (design:
// whats-next-panel): up to three steps ready right now, an in-place expander for
// the rest, and two empty states that never dead-end. The ranking is the shared
// planNextUp rule (nextUpPlan.js, also read by the phone list's shelf); the host
// computes the plan and hands it in. This file keeps the section's presentation
// and considerAutoOpen — the return-visit rule over a per-tree localStorage stamp.

import React, { useState } from 'react';
import { Icon } from '../../../design-system';
import { NODE_COLORS, DEFAULT_NODE_COLOR } from '../theme.js';

const RETURN_GAP_MS = 12 * 60 * 60 * 1000;
const AUTO_OPEN_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MIN_AUTO_OPEN_STEPS = 12;
const VISIT_KEY_PREFIX = 'windmill:nextup:';

// The return-visit rule (§04): stamp every open; auto-open only when the last open
// was ≥12h ago, ≥1 step is ready, the tree has ≥12 steps, and at most once a day.
// A first-ever open is not a return — the user is already looking. The daily budget
// isn't burned at decision time (X6): commit() stamps it, and the caller invokes
// commit() only at the moment the auto-open actually fires.
export function considerAutoOpen({ treeId, readyCount, stepCount, now = Date.now(), storage = window.localStorage }) {
  let record = null;
  try { record = JSON.parse(storage.getItem(VISIT_KEY_PREFIX + treeId)); } catch { record = null; }
  const lastVisitAt = record?.lastVisitAt ?? null;
  const lastAutoOpenAt = record?.lastAutoOpenAt ?? null;
  const returning = lastVisitAt !== null && now - lastVisitAt >= RETURN_GAP_MS;
  const rested = lastAutoOpenAt === null || now - lastAutoOpenAt >= AUTO_OPEN_COOLDOWN_MS;
  const open = returning && rested && readyCount >= 1 && stepCount >= MIN_AUTO_OPEN_STEPS;
  const stamp = (autoOpenAt) => {
    // the visit stamp is best-effort, never fatal — same contract as the stores
    try { storage.setItem(VISIT_KEY_PREFIX + treeId, JSON.stringify({ lastVisitAt: now, lastAutoOpenAt: autoOpenAt })); } catch {}
  };
  stamp(lastAutoOpenAt);
  return { open, commit: () => stamp(now) };
}

export function NextUp({ plan, nodesById, states, onHoverNode, onLeaveNode, onOpenStep, onAddStep }) {
  const [expanded, setExpanded] = useState(false);

  if (plan.mode === 'allDone') {
    return (
      <div className="st-nextup st-nextup--empty">
        <span className="st-nextup-crown"><Icon name="crown" size={18} /></span>
        <p className="st-nextup-line">Every step is done.</p>
        <p className="st-nextup-tally">{plan.doneCount}/{plan.totalCount} · fully grown</p>
        <p className="st-nextup-links">
          <button type="button" onClick={onAddStep}>Add a step</button>
          <span aria-hidden="true">·</span>
          <a href="#/app/new">Plant a new tree</a>
        </p>
      </div>
    );
  }

  if (plan.mode === 'blocked') {
    return (
      <div className="st-nextup st-nextup--empty">
        <p className="st-nextup-line">Nothing’s unlocked yet.</p>
        <p className="st-nextup-hint">Finish what’s growing to open the path:</p>
        <div className="st-nextup-rows">
          {plan.blockers.map((entry) => (
            <StepRow key={entry.id} entry={entry} node={nodesById.get(entry.id)} state={states.get(entry.id)} ember onHover={onHoverNode} onLeave={onLeaveNode} onOpen={onOpenStep} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="st-nextup">
      <div className="st-nextup-rows">
        {plan.featured.map((entry) => (
          <StepRow key={entry.id} entry={entry} node={nodesById.get(entry.id)} state={states.get(entry.id)} onHover={onHoverNode} onLeave={onLeaveNode} onOpen={onOpenStep} />
        ))}
        {expanded && plan.overflow.map((entry) => (
          <StepRow key={entry.id} entry={entry} node={nodesById.get(entry.id)} state={states.get(entry.id)} onHover={onHoverNode} onLeave={onLeaveNode} onOpen={onOpenStep} />
        ))}
      </div>
      {plan.overflow.length > 0 && !expanded && (
        <button type="button" className="st-nextup-more" onClick={() => setExpanded(true)}>
          + {plan.overflow.length} more ready
        </button>
      )}
    </div>
  );
}

// One row (§03.1): the fruit at its canvas treatment — a white disc in a kind-hue
// ready ring, or the static ember for a blocker — the name body-bold, one line of
// consequence in counts only (a leaf says nothing), and a hover-revealed fly.
function StepRow({ entry, node, state, ember = false, onHover, onLeave, onOpen }) {
  if (!node) return null; // deleted while the plan was frozen — the row simply retires
  if (state !== (ember ? 'active' : 'available')) return null; // live state left the tier — same silent retirement, no reshuffle (X5)
  const hue = NODE_COLORS[node.color] ?? NODE_COLORS[DEFAULT_NODE_COLOR];
  return (
    <button
      type="button"
      className="st-nextup-row"
      onMouseEnter={() => onHover?.(entry.id)}
      onMouseLeave={() => onLeave?.()}
      onClick={() => onOpen?.(entry.id)}
    >
      <span
        className="st-nextup-disc"
        style={ember
          ? { background: hue.base, boxShadow: `0 0 8px 2px ${hue.glow}` }
          : { boxShadow: `inset 0 0 0 2px ${hue.base}` }}
      />
      <span className="st-nextup-text">
        <span className="st-nextup-name">{node.label?.trim() || 'Unnamed step'}</span>
        {entry.unlocks > 0 && (
          <span className="st-nextup-sub">unlocks {entry.unlocks} more step{entry.unlocks === 1 ? '' : 's'}</span>
        )}
      </span>
      <span className="st-nextup-fly"><Icon name="arrow-right" size={14} /></span>
    </button>
  );
}
