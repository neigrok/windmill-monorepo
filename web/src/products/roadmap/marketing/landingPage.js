// Roadmap's landing at /roadmap, as words, links and pictures: the shell draws it (shell/marketing/ProductLanding.jsx)
// and scripts/build-landing-shells.mjs writes the same words into the first HTML, so this module stays plain
// Node-readable data. A heading breaks where its words hold a newline; `to` names what a link opens in its event.

import { lazy } from 'react';
import { frontPicture } from './frontPicture.js';
import { t } from '../i18n/landing/index.js';

const pictures = () => import('./LandingPictures.jsx');
const picture = (name) => lazy(() => pictures().then((module) => ({ default: module[name] })));
const start = { href: '#/app/start', label: t('roadmap.root.link'), to: 'room' };

export const roadmapLandingPage = {
  first: {
    heading: t('roadmap.landing.heading', { break: '\n' }),
    headingBreaks: 'narrow',
    line: t('roadmap.landing.line'),
    links: [start, { href: '#/demo', label: t('roadmap.landing.tryDemo'), to: 'demo' }],
    trust: t('roadmap.landing.trust'),
    picture: {
      name: 'hero',
      label: t('roadmap.scene.composed'),
      stages: [{ name: 'narrow', width: 356, height: 376 }, { name: 'wide', width: 1310, height: 605 }],
      Picture: picture('HeroTree'),
    },
  },
  sections: [
    {
      key: 'connect',
      title: t('roadmap.root.title', { break: '\n' }),
      paragraph: t('roadmap.landing.connect.paragraph'),
      picture: frontPicture,
      features: [
        { title: t('roadmap.landing.connect.grantTitle'), text: t('roadmap.landing.connect.grantText') },
        { title: t('roadmap.landing.connect.editsTitle'), text: t('roadmap.landing.connect.editsText') },
        { title: t('roadmap.landing.connect.publishTitle'), text: t('roadmap.landing.connect.publishText') },
      ],
      link: { href: '/connect.html', label: t('roadmap.landing.connect.link'), to: 'connect' },
    },
    {
      key: 'unlock',
      title: t('roadmap.landing.unlock.title', { break: '\n' }),
      paragraph: t('roadmap.landing.unlock.paragraph'),
      picture: {
        name: 'unlock',
        label: t('roadmap.scene.composed'),
        stages: [{ name: 'narrow', width: 356, height: 528 }, { name: 'wide', width: 1100, height: 413 }],
        Picture: picture('UnlockStages'),
      },
      features: [
        { title: t('roadmap.landing.unlock.boardTitle'), text: t('roadmap.landing.unlock.boardText') },
        { title: t('roadmap.landing.unlock.graphTitle'), text: t('roadmap.landing.unlock.graphText') },
        { title: t('roadmap.landing.unlock.loopsTitle'), text: t('roadmap.landing.unlock.loopsText') },
      ],
    },
    {
      key: 'start',
      title: t('roadmap.landing.start.title', { break: '\n' }),
      paragraph: t('roadmap.landing.start.paragraph'),
      picture: {
        name: 'paths',
        label: t('roadmap.landing.start.picture'),
        stages: [{ name: 'narrow', width: 356, height: 450 }, { name: 'wide', width: 1192, height: 297 }],
        Picture: picture('PathCards'),
      },
      features: [
        { title: t('roadmap.landing.start.pathsTitle'), text: t('roadmap.landing.start.pathsText') },
        { title: t('roadmap.landing.start.pasteTitle'), text: t('roadmap.landing.start.pasteText') },
        { title: t('roadmap.landing.start.laterTitle'), text: t('roadmap.landing.start.laterText') },
      ],
    },
    {
      key: 'step',
      title: t('roadmap.landing.step.title', { break: '\n' }),
      paragraph: t('roadmap.landing.step.paragraph'),
      picture: {
        name: 'step',
        label: t('roadmap.landing.step.picture'),
        stages: [{ name: 'panel', width: 356, height: 676 }],
        Picture: picture('StepPanel'),
      },
      features: [
        { title: t('roadmap.landing.step.treesTitle'), text: t('roadmap.landing.step.treesText') },
        { title: t('roadmap.landing.step.findTitle'), text: t('roadmap.landing.step.findText') },
        { title: t('roadmap.landing.step.phoneTitle'), text: t('roadmap.landing.step.phoneText') },
      ],
    },
    {
      key: 'publish',
      title: t('roadmap.landing.publish.title', { break: '\n' }),
      paragraph: t('roadmap.landing.publish.paragraph'),
      picture: {
        name: 'fork',
        label: t('roadmap.scene.composed'),
        stages: [{ name: 'narrow', width: 356, height: 312 }, { name: 'wide', width: 860, height: 472 }],
        Picture: picture('ForkTree'),
      },
      features: [
        { title: t('roadmap.landing.publish.forkTitle'), text: t('roadmap.landing.publish.forkText') },
        { title: t('roadmap.landing.publish.galleryTitle'), text: t('roadmap.landing.publish.galleryText') },
        { title: t('roadmap.landing.publish.privateTitle'), text: t('roadmap.landing.publish.privateText') },
      ],
      link: { href: '/gallery', label: t('roadmap.landing.publish.link'), to: 'gallery' },
    },
    {
      key: 'account',
      title: t('roadmap.landing.account.title', { break: '\n' }),
      paragraph: t('roadmap.landing.account.paragraph'),
      features: [
        { title: t('roadmap.landing.account.offlineTitle'), text: t('roadmap.landing.account.offlineText') },
        { title: t('roadmap.landing.account.exportTitle'), text: t('roadmap.landing.account.exportText') },
        { title: t('roadmap.landing.account.freeTitle'), text: t('roadmap.landing.account.freeText') },
      ],
    },
    {
      pair: [
        {
          key: 'limits',
          title: t('roadmap.landing.limits.title', { break: '\n' }),
          paragraph: t('roadmap.landing.limits.paragraph'),
          features: [
            { title: t('roadmap.landing.limits.colourTitle'), text: t('roadmap.landing.limits.colourText') },
            { title: t('roadmap.landing.limits.shareTitle'), text: t('roadmap.landing.limits.shareText') },
            { title: t('roadmap.landing.limits.editTitle'), text: t('roadmap.landing.limits.editText') },
          ],
        },
        {
          key: 'data',
          title: t('roadmap.landing.data.title', { break: '\n' }),
          paragraph: t('roadmap.landing.data.paragraph'),
          features: [
            { title: t('roadmap.landing.data.publishedTitle'), text: t('roadmap.landing.data.publishedText') },
            { title: t('roadmap.landing.data.assistantTitle'), text: t('roadmap.landing.data.assistantText') },
            { title: t('roadmap.landing.data.othersTitle'), text: t('roadmap.landing.data.othersText'),
              link: { href: '/privacy.html', label: t('roadmap.landing.data.privacy'), to: 'privacy' } },
          ],
        },
      ],
    },
  ],
  runs: t('roadmap.landing.runs'),
  questionsTitle: t('roadmap.landing.questions.title'),
  questions: [
    { question: t('roadmap.landing.questions.whatQuestion'), answer: t('roadmap.landing.questions.whatAnswer') },
    { question: t('roadmap.landing.questions.makeQuestion'), answer: t('roadmap.landing.questions.makeAnswer') },
    { question: t('roadmap.landing.questions.breakQuestion'), answer: t('roadmap.landing.questions.breakAnswer') },
    { question: t('roadmap.landing.questions.firstQuestion'), answer: t('roadmap.landing.questions.firstAnswer') },
    { question: t('roadmap.landing.questions.textQuestion'), answer: t('roadmap.landing.questions.textAnswer') },
    { question: t('roadmap.landing.questions.freeQuestion'), answer: t('roadmap.landing.questions.freeAnswer') },
    { question: t('roadmap.landing.questions.othersQuestion'), answer: t('roadmap.landing.questions.othersAnswer') },
  ],
  closing: { line: t('roadmap.landing.closing'), link: start },
};
