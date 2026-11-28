// Gym's landing at /gym, as words, links and pictures: the shell draws it (shell/marketing/ProductLanding.jsx) and
// scripts/build-landing-shells.mjs writes the same words into the first HTML, so this module stays plain Node-readable
// data. A heading breaks where its words hold a newline; `to` names what a link opens in its event.

import { lazy } from 'react';
import { frontPicture } from './frontPicture.js';
import { t } from '../i18n/landing/index.js';

const pictures = () => import('./LandingPictures.jsx');
const picture = (name) => lazy(() => pictures().then((module) => ({ default: module[name] })));
const where = { href: '#where', label: t('gym.landing.whereLink'), to: 'section' };
const openLog = { href: '#/gym', label: t('gym.landing.openLog'), to: 'room' };
// The room's night scenes, 328 × 190: twice that with 40 around on a wide stage, the frame's width on a phone.
const SCENE_STAGES = [{ name: 'narrow', width: 356, height: 205 }, { name: 'wide', width: 736, height: 460 }];

export const gymLandingPage = {
  first: {
    heading: t('gym.landing.heading', { break: '\n' }),
    headingBreaks: 'wide',
    line: t('gym.landing.line'),
    links: [openLog, where],
    trust: t('gym.landing.trust'),
    picture: { name: 'logger', label: t('gym.landing.firstPicture'), stages: SCENE_STAGES, Picture: picture('SetLogger') },
  },
  sections: [
    {
      key: 'coach',
      title: t('gym.landing.coach.title', { break: '\n' }),
      paragraph: t('gym.landing.coach.paragraph'),
      picture: frontPicture,
      features: [
        { title: t('gym.landing.coach.receiptTitle'), text: t('gym.landing.coach.receiptText') },
        { title: t('gym.landing.coach.askedTitle'), text: t('gym.landing.coach.askedText') },
        { title: t('gym.landing.coach.neverTitle'), text: t('gym.landing.coach.neverText') },
      ],
      line: t('gym.landing.coach.line'),
      link: { href: '/pricing.html', label: t('gym.landing.coach.pricing'), to: 'pricing' },
    },
    {
      key: 'own',
      title: t('gym.landing.own.title', { break: '\n' }),
      paragraph: t('gym.landing.own.paragraph'),
      picture: {
        name: 'connect',
        label: t('gym.landing.own.picture'),
        stages: [{ name: 'narrow', width: 356, height: 400 }, { name: 'wide', width: 600, height: 336 }],
        Picture: picture('ConnectCard'),
      },
      features: [
        { title: t('gym.landing.own.readTitle'), text: t('gym.landing.own.readText') },
        { title: t('gym.landing.own.writeTitle'), text: t('gym.landing.own.writeText') },
        { title: t('gym.landing.own.neverTitle'), text: t('gym.landing.own.neverText') },
      ],
      line: t('gym.landing.own.line'),
      link: { href: '/connect.html', label: t('gym.landing.own.connect'), to: 'connect' },
    },
    {
      key: 'remembers',
      title: t('gym.landing.remembers.title', { break: '\n' }),
      paragraph: t('gym.landing.remembers.paragraph'),
      picture: { name: 'remembered', label: t('gym.landing.firstPicture'), stages: SCENE_STAGES, Picture: picture('RememberedSet') },
      features: [
        { title: t('gym.landing.remembers.lockTitle'), text: t('gym.landing.remembers.lockText') },
        { title: t('gym.landing.remembers.receiptTitle'), text: t('gym.landing.remembers.receiptText') },
        { title: t('gym.landing.remembers.fixTitle'), text: t('gym.landing.remembers.fixText') },
      ],
    },
    {
      key: 'overload',
      title: t('gym.landing.overload.title', { break: '\n' }),
      paragraph: t('gym.landing.overload.paragraph'),
      picture: { name: 'strength', label: t('gym.landing.overload.picture'), stages: SCENE_STAGES, Picture: picture('StrengthLine') },
      features: [
        { title: t('gym.landing.overload.e1rmTitle'), text: t('gym.landing.overload.e1rmText') },
        { title: t('gym.landing.overload.gapsTitle'), text: t('gym.landing.overload.gapsText') },
        { title: t('gym.landing.overload.recordsTitle'), text: t('gym.landing.overload.recordsText') },
      ],
    },
    {
      key: 'program',
      title: t('gym.landing.program.title', { break: '\n' }),
      paragraph: t('gym.landing.program.paragraph'),
      picture: {
        name: 'routine',
        label: t('gym.landing.program.picture'),
        stages: [{ name: 'narrow', width: 356, height: 380 }, { name: 'wide', width: 600, height: 428 }],
        Picture: picture('Routine'),
      },
      features: [
        { title: t('gym.landing.program.movementsTitle'), text: t('gym.landing.program.movementsText') },
        { title: t('gym.landing.program.pictureTitle'), text: t('gym.landing.program.pictureText') },
        { title: t('gym.landing.program.bodyweightTitle'), text: t('gym.landing.program.bodyweightText') },
      ],
    },
    {
      pair: [
        {
          key: 'limits',
          title: t('gym.landing.limits.title', { break: '\n' }),
          paragraph: t('gym.landing.limits.paragraph'),
          features: [
            { title: t('gym.landing.limits.backTitle'), text: t('gym.landing.limits.backText') },
            { title: t('gym.landing.limits.bodyTitle'), text: t('gym.landing.limits.bodyText') },
            { title: t('gym.landing.limits.feedTitle'), text: t('gym.landing.limits.feedText') },
          ],
        },
        {
          key: 'data',
          title: t('gym.landing.data.title', { break: '\n' }),
          paragraph: t('gym.landing.data.paragraph'),
          features: [
            { title: t('gym.landing.data.coachTitle'), text: t('gym.landing.data.coachText') },
            { title: t('gym.landing.data.shareTitle'), text: t('gym.landing.data.shareText') },
            { title: t('gym.landing.data.assistantTitle'), text: t('gym.landing.data.assistantText') },
          ],
          link: { href: '/privacy.html', label: t('gym.landing.data.privacy'), to: 'privacy' },
        },
      ],
    },
    {
      key: 'where',
      id: 'where',
      title: t('gym.landing.runs.title'),
      paragraph: t('gym.landing.runs.paragraph'),
      features: [
        { title: t('gym.landing.runs.androidTitle'), text: t('gym.landing.runs.androidText') },
        { title: t('gym.landing.runs.iphoneTitle'), text: t('gym.landing.runs.iphoneText') },
        { title: t('gym.landing.runs.webTitle'), text: t('gym.landing.runs.webText') },
      ],
    },
  ],
  questionsTitle: t('gym.landing.questions.title'),
  questions: [
    { question: t('gym.landing.questions.overloadQuestion'), answer: t('gym.landing.questions.overloadAnswer') },
    { question: t('gym.landing.questions.lastQuestion'), answer: t('gym.landing.questions.lastAnswer') },
    { question: t('gym.landing.questions.increaseQuestion'), answer: t('gym.landing.questions.increaseAnswer') },
    { question: t('gym.landing.questions.changeQuestion'), answer: t('gym.landing.questions.changeAnswer') },
    { question: t('gym.landing.questions.assistantQuestion'), answer: t('gym.landing.questions.assistantAnswer') },
    { question: t('gym.landing.questions.e1rmQuestion'), answer: t('gym.landing.questions.e1rmAnswer') },
    { question: t('gym.landing.questions.browserQuestion'), answer: t('gym.landing.questions.browserAnswer') },
    { question: t('gym.landing.questions.freeQuestion'), answer: t('gym.landing.questions.freeAnswer') },
  ],
  closing: { line: t('gym.landing.closing'), link: openLog },
};
