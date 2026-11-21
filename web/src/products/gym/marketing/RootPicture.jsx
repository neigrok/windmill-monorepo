// Gym's picture on the brand root: one Coach turn as the room draws it. The question, the receipt in
// the room's own sentence, the answer, and the proposal with its two acts. A still composition on the
// gym ground of the hour; nothing in it is a control. The shell frames and labels it.

import React from 'react';
import { t } from '../i18n/entry/index.js';
import './gymRootPicture.css';

const figure = (value) => <span className="gyPicture-figure">{value}</span>;
const withFigures = (text) => text.split(/(\d+(?:\.\d+)?)/).map((part, index) => (index % 2 ? <span className="gyPicture-figure" key={index}>{part}</span> : part));

export function GymPicture() {
  return (
    <div className="gyPicture gym-skin">
      <div className="gyPicture-thread">
        <p className="gyPicture-question">{t('gym.root.question')}</p>
        <p className="gyPicture-receipt">
          <span>{t('gym.coach.read', { sets: 412, weeks: 14, sessions: 41, setsShown: figure(412), weeksShown: figure(14), sessionsShown: figure(41) })}</span>
          <span className="gyPicture-steps">{t('gym.coach.stepCount', { count: 3, figure: figure(3) })}<span className="gyPicture-more">›</span></span>
        </p>
        <p className="gyPicture-answer">{withFigures(t('gym.root.answer'))}</p>
        <div className="gyPicture-proposal">
          <p className="gyPicture-kicker">{t('gym.root.routine')}{` · ${t('gym.proposals.changeCount', { count: 1 })}`}</p>
          <p className="gyPicture-change">
            <b>{t('gym.root.movement')}</b>
            <span className="gyPicture-figure">{t('gym.root.change', { next: <span className="gyPicture-next">{t('gym.root.changeNext')}</span> })}</span>
          </p>
          <p className="gyPicture-kept">{t('gym.proposals.keptRun', { count: 2 })}<span className="gyPicture-more">›</span></p>
          <span className="gyPicture-apply">{t('gym.common.apply')}</span>
          <p className="gyPicture-kept">{t('gym.proposals.loggedSetsUnchanged')}</p>
          <span className="gyPicture-turnDown">{t('gym.proposals.turnDown')}</span>
        </div>
      </div>
    </div>
  );
}
