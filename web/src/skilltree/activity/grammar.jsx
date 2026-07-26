// The one grammar every activity surface speaks — the feed rows, the step
// panel's History, and the arrival ticker all compose from here, so a change to
// how a verb reads happens once. Verb hues follow the fruit lifecycle (design:
// event-log-options): terracotta ✓ completed, gold ▶ started, olive unlock,
// bark + added, neutral ✎ renamed, brick − removed.

import React from 'react';
import { Icon, Avatar } from '../../components';
import { NODE_COLORS, DEFAULT_NODE_COLOR } from '../theme.js';

export const VERB_STYLE = {
  started: { icon: 'play', bg: 'var(--accent-gold-500)', fg: '#fff', label: 'Started' },
  completed: { icon: 'check', bg: 'var(--accent-terracotta-500)', fg: '#fff', label: 'Completed' },
  unlocked: { icon: 'unlock', bg: 'var(--accent-olive-500)', fg: '#fff', label: 'Unlocked' },
  added: { icon: 'plus', bg: 'var(--color-bark)', fg: '#fff', label: 'Added' },
  renamed: { icon: 'pencil', bg: 'var(--neutral-400)', fg: '#fff', label: 'Renamed' },
  removed: { icon: 'minus', bg: 'var(--accent-brick-500)', fg: '#fff', label: 'Removed' },
  // Structural deeds from the server op log — rendered from the event's own `summary`.
  linked: { icon: 'link', bg: 'var(--color-bark)', fg: '#fff', label: 'Linked' },
  unlinked: { icon: 'unlink', bg: 'var(--accent-brick-500)', fg: '#fff', label: 'Unlinked' },
  rerouted: { icon: 'shuffle', bg: 'var(--accent-gold-500)', fg: '#fff', label: 'Rerouted' },
  recolored: { icon: 'palette', bg: 'var(--neutral-400)', fg: '#fff', label: 'Recolored' },
  tidied: { icon: 'sparkles', bg: 'var(--accent-olive-500)', fg: '#fff', label: 'Tidied' },
};

export function relativeTime(at, now) {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}

export function VerbBadge({ verb, size = 13 }) {
  const style = VERB_STYLE[verb];
  if (!style) return null;
  return (
    <span className="st-event-badge" style={{ width: size, height: size, background: style.bg, color: style.fg }}>
      <Icon name={style.icon} size={Math.round(size * 0.62)} strokeWidth={3} />
    </span>
  );
}

// The actor: a person's initial avatar with the verb badge tucked in its corner,
// or — for a system unlock — the tree's own bark glyph, since an unlock belongs
// to the tree, not a person.
export function ActorAvatar({ event, size = 22 }) {
  if (!event.actor) {
    return (
      <span className="st-event-avatar st-event-avatar--system" style={{ width: size, height: size }}>
        <Icon name="unlock" size={Math.round(size * 0.52)} />
      </span>
    );
  }
  return (
    <span className="st-event-avatar" style={{ width: size, height: size }}>
      <Avatar name={event.actor} size={size} />
      <VerbBadge verb={event.verb} />
    </span>
  );
}

// The object of the sentence: the node it happened to, wearing its kind-hue dot.
// A node that no longer exists (removed, or an undone create) loses the dot,
// mutes, and strikes through — it can't be linked to on the graph anymore.
export function ObjectLabel({ event, node }) {
  const label = (node ? node.label : event.label) || 'Unnamed step';
  if (!node) return <span className="st-event-obj st-event-obj--dead">{label}</span>;
  const kind = node.color ?? event.kind ?? DEFAULT_NODE_COLOR;
  return (
    <span className="st-event-obj">
      <i style={{ background: NODE_COLORS[kind]?.base }} />
      {label}
    </span>
  );
}

export function EventSentence({ event, node }) {
  const object = <ObjectLabel event={event} node={node} />;
  const actor = event.actor ? <b>{event.actor}</b> : null;
  switch (event.verb) {
    case 'completed': return <>{actor} completed {object}</>;
    case 'started': return <>{actor} started {object}</>;
    case 'added': return <>{actor} added a step {object}</>;
    case 'renamed': return <>{actor} renamed {object}</>;
    case 'removed': return <>{actor} removed {object}</>;
    case 'unlocked': return <>{object} unlocked</>;
    // Structural deeds (linked/unlinked/rerouted/recolored/tidied) name their own nodes,
    // so the server's ready sentence reads better than a fixed template can.
    default: return event.summary ? <>{actor} {event.summary}</> : object;
  }
}
