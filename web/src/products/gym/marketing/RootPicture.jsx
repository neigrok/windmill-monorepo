// Gym's picture on the brand root: one Coach turn, its receipt in the room's own sentence, on the stage the shell names.

import React from 'react';
import { BookOpen, ChevronRight } from 'lucide-react';
import { t } from '../i18n/entry/index.js';
import './gymRootPicture.css';

const withFigures = (text) => text.split(/(\d+(?:\.\d+)?)/).map((part, index) => (index % 2 ? <span className="gyPicture-figure" key={index}>{part}</span> : part));

export function GymPicture({ stage }) {
  return (
    <div className="gyPicture gym-skin" data-stage={stage}>
      <div className="gyPicture-thread">
        <p className="gyPicture-question">{t('gym.root.question')}</p>
        <p className="gyPicture-receipt">
          <BookOpen size={16} aria-hidden="true" />{t('gym.coach.receipt.read', { sessions: 41, weeks: 14 })}<ChevronRight size={16} aria-hidden="true" />
        </p>
        <p className="gyPicture-answer">{withFigures(t('gym.root.answer'))}</p>
        <div className="gyPicture-proposal">
          <p className="gyPicture-kicker">{t('gym.root.routine')}{` · ${t('gym.proposals.changeCount', { count: 1 })}`}</p>
          <p className="gyPicture-change">
            <b>{t('gym.root.movement')}</b>
            <span className="gyPicture-figure">{t('gym.root.change', { next: <span className="gyPicture-next">{t('gym.root.changeNext')}</span> })}</span>
          </p>
          <p className="gyPicture-kept gyPicture-unfold">{t('gym.proposals.keptRun', { count: 2 })}<span className="gyPicture-more">›</span></p>
          <span className="gyPicture-apply">{t('gym.common.apply')}</span>
          <p className="gyPicture-kept">{t('gym.proposals.loggedSetsUnchanged')}</p>
          <span className="gyPicture-turnDown">{t('gym.proposals.turnDown')}</span>
        </div>
      </div>
    </div>
  );
}
