import React from 'react';
import { Icon, Avatar } from '../../../design-system';
import { KIND_CSS, DEFAULT_NODE_COLOR } from '../theme.js';
import { STEP_DETAIL } from '../copy.js';
import { t } from '../i18n/index.js';

const VERB_STYLE = {
  started: { icon: 'play', bg: 'var(--accent-gold-500)', fg: '#fff' },
  completed: { icon: 'check', bg: 'var(--accent-terracotta-500)', fg: '#fff' },
  unlocked: { icon: 'unlock', bg: 'var(--accent-olive-500)', fg: '#fff' },
  added: { icon: 'plus', bg: 'var(--color-bark)', fg: '#fff' },
  renamed: { icon: 'pencil', bg: 'var(--neutral-400)', fg: '#fff' },
  removed: { icon: 'minus', bg: 'var(--accent-brick-500)', fg: '#fff' },
  // Structural deeds render from the event's own `summary`.
  linked: { icon: 'link', bg: 'var(--color-bark)', fg: '#fff' },
  unlinked: { icon: 'unlink', bg: 'var(--accent-brick-500)', fg: '#fff' },
  rerouted: { icon: 'shuffle', bg: 'var(--accent-gold-500)', fg: '#fff' },
  recolored: { icon: 'palette', bg: 'var(--neutral-400)', fg: '#fff' },
  tidied: { icon: 'sparkles', bg: 'var(--accent-olive-500)', fg: '#fff' },
};

export function relativeTime(at, now) {
  if (at == null) return '';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return t('roadmap.ago.now');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('roadmap.ago.minutesCompact', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('roadmap.ago.hoursCompact', { count: hours });
  const days = Math.round(hours / 24);
  if (days < 7) return t('roadmap.ago.daysCompact', { count: days });
  return t('roadmap.ago.weeksCompact', { count: Math.round(days / 7) });
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

function ObjectLabel({ event, node }) {
  const label = (node ? node.label : event.label) || STEP_DETAIL.unnamed;
  if (!node) return <span className="st-event-obj st-event-obj--dead">{label}</span>;
  const kind = node.color ?? event.kind ?? DEFAULT_NODE_COLOR;
  return (
    <span className="st-event-obj">
      <i style={{ background: KIND_CSS[kind]?.base }} />
      {label}
    </span>
  );
}

export function EventSentence({ event, node }) {
  const object = <ObjectLabel event={event} node={node} />;
  const actor = event.actor ? <b>{event.actor}</b> : '';
  switch (event.verb) {
    case 'completed': return t('roadmap.activity.completed', { actor, object });
    case 'started': return t('roadmap.activity.started', { actor, object });
    case 'added': return t('roadmap.activity.added', { actor, object });
    case 'renamed': return t('roadmap.activity.renamed', { actor, object });
    case 'removed': return t('roadmap.activity.removed', { actor, object });
    case 'unlocked': return t('roadmap.activity.unlocked', { object });
    default: return event.summary ? <>{actor} {event.summary}</> : object;
  }
}
