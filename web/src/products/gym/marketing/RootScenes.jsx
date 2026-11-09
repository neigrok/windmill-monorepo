// Gym's two scenes on the brand root: the hero band's glimpse and the section's illustration. Both
// are still — the root's one infinite motion is the roadmap crown — and both stand on the gym ground
// the root paints their band with, so every colour is that ground's own token.
//
// Each is a figure holding one hidden stage and one caption: the session is composed, so a screen
// reader is spared the numbers nobody lifted and told the caption instead. Everything drawn inside
// the stage is assembled from what gym actually ships — the proposal's two acts are the shipped
// review's own, Apply as the band across the card and TURN_DOWN_VERB as the plain row beneath it
// (Proposals.jsx). The verb is the landing's own message rather than an import, because proposals.js
// carries the whole diff grammar and the root may not pay for it; the scene test pins the two together.

import React from 'react';
import { Icon } from '../../../design-system';
import { t } from '../i18n/index.js';
import './gymRootScenes.css';

const STEPS = ['-10', '-2.5', '+2.5', '+10'];

function Stepper() {
  return (
    <div className="gyRoot-chips">
      {STEPS.map((step) => <span key={step} className="gychip">{step}</span>)}
    </div>
  );
}

function LoggedSet({ n, reps }) {
  return (
    <div className="gyWell">
      <div className="gyset">
        <span className="gyRoot-setn">{t('gym.landing.scenes.setNumber', { n })}</span>
        <span>{reps}</span>
        <span className="gyck"><Icon name="check" size={13} strokeWidth={2.6} /></span>
      </div>
    </div>
  );
}

export function GymGlimpse() {
  return (
    <figure className="gyRoot-scene">
      <div className="gyw gym-skin gyRoot" aria-hidden="true">
        <div className="gyRoot-head">
          <b className="gyRoot-lift">{t('gym.landing.lift.squat')}</b>
          <span className="gyRoot-set">{t('gym.landing.scenes.setOf')}</span>
        </div>
        <div className="gyRoot-glimpse-body">
          <div className="gyRoot-readout">100<span className="gyCaption">{t('gym.landing.scenes.readoutUnit')}</span></div>
          <Stepper />
          <div className="gyRoot-last">{t('gym.landing.scenes.lastTime')}</div>
          <span className="gyRoot-button">{t('gym.landing.logSet')}</span>
        </div>
      </div>
      <figcaption className="composed">{t('gym.landing.scenes.composed')}</figcaption>
    </figure>
  );
}

export function GymIllustration() {
  return (
    <figure className="gyRoot-scene">
      <div className="gyRoot-pair" aria-hidden="true">
        <div className="gyw gym-skin gyRoot gyRoot-phone">
          <span className="gyRoot-notch" />
          <div className="gyRoot-head">
            <b className="gyRoot-lift">{t('gym.landing.lift.squat')}</b>
            <span className="gyRoot-set">{t('gym.landing.scenes.setOf')}</span>
          </div>
          <div className="gyRoot-readout">100<span className="gyCaption">{t('gym.landing.scenes.readoutUnit')}</span></div>
          <div className="gyRoot-last">{t('gym.landing.scenes.lastTime')}</div>
          <Stepper />
          <span className="gyRoot-button">{t('gym.landing.logSet')}</span>
          <LoggedSet n="1" reps="100 × 5" />
          <LoggedSet n="2" reps="100 × 5" />
        </div>
        <div className="gyw gym-skin gyRoot gyRoot-proposal">
          <div className="gyRoot-by"><i />{t('gym.landing.scenes.proposedBy')}</div>
          <b className="gyRoot-lift">{t('gym.landing.scenes.proposalLift')}</b>
          <div className="gyRoot-diff">
            <span>{t('gym.landing.scenes.diffRemoved')}</span>
            <span className="gyRoot-diff-add">{t('gym.landing.scenes.diffAdded')}</span>
          </div>
          <p className="gyRoot-why">{t('gym.landing.scenes.why')}</p>
          <div className="gyRoot-acts">
            <span className="gyRoot-button">{t('gym.landing.scenes.apply')}</span>
            <span className="gyRoot-turn-down">{t('gym.landing.scenes.turnDown')}</span>
          </div>
        </div>
      </div>
      <figcaption className="composed">{t('gym.landing.scenes.composed')}</figcaption>
    </figure>
  );
}
