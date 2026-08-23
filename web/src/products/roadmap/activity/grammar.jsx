import React from 'react';
import { Icon, Avatar } from '../../../design-system';
import { NODE_COLORS, DEFAULT_NODE_COLOR } from '../theme.js';

export const VERB_STYLE = {
  started: { icon: 'play', bg: 'var(--accent-gold-500)', fg: '#fff', label: 'Started' },
  completed: { icon: 'check', bg: 'var(--accent-terracotta-500)', fg: '#fff', label: 'Completed' },
  unlocked: { icon: 'unlock', bg: 'var(--accent-olive-500)', fg: '#fff', label: 'Unlocked' },
  added: { icon: 'plus', bg: 'var(--color-bark)', fg: '#fff', label: 'Added' },
  renamed: { icon: 'pencil', bg: 'var(--neutral-400)', fg: '#fff', label: 'Renamed' },
  removed: { icon: 'minus', bg: 'var(--accent-brick-500)', fg: '#fff', label: 'Removed' },
  // Structural deeds render from the event's own `summary`.
  linked: { icon: 'link', bg: 'var(--color-bark)', fg: '#fff', label: 'Linked' },
  unlinked: { icon: 'unlink', bg: 'var(--accent-brick-500)', fg: '#fff', label: 'Unlinked' },
  rerouted: { icon: 'shuffle', bg: 'var(--accent-gold-500)', fg: '#fff', label: 'Rerouted' },
  recolored: { icon: 'palette', bg: 'var(--neutral-400)', fg: '#fff', label: 'Recolored' },
  tidied: { icon: 'sparkles', bg: 'var(--accent-olive-500)', fg: '#fff', label: 'Tidied' },
};

export function relativeTime(at, now) {
  if (at == null) return '';
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

function VerbBadge({ verb, size = 13 }) {
  const style = VERB_STYLE[verb];
  if (!style) return null;
  return (
    <span className="st-event-badge" style={{ width: size, height: size, background: style.bg, color: style.fg }}>
      <Icon name={style.icon} size={Math.round(size * 0.62)} strokeWidth={3} />
    </span>
  );
}

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
    default: return event.summary ? <>{actor} {event.summary}</> : object;
  }
}
