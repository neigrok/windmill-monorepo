// The journal's landing at /journal, as words, links and pictures: the shell draws it (shell/marketing/ProductLanding.jsx)
// and scripts/build-landing-shells.mjs writes the same words into the first HTML, so this module stays plain
// Node-readable data. A heading breaks where its words hold a newline; `to` names what a link opens in its event.

import { lazy } from 'react';
import { frontPicture } from './frontPicture.js';
import { t } from '../i18n/landing/index.js';

const pictures = () => import('./LandingPictures.jsx');
const picture = (name) => lazy(() => pictures().then((module) => ({ default: module[name] })));
const write = { href: '#/journal', label: t('journal.root.link'), to: 'room' };
// A scene of the room, 328 × 190: twice that with 40 around on a wide stage, the frame's width on a phone.
const SCENE_STAGES = [{ name: 'narrow', width: 356, height: 205 }, { name: 'wide', width: 736, height: 460 }];

export const journalLandingPage = {
  first: {
    heading: t('journal.landing.heading'),
    line: t('journal.landing.line'),
    links: [write, { href: '#echoes', label: t('journal.landing.howLink'), to: 'section' }],
    trust: t('journal.landing.trust'),
    picture: {
      name: 'night',
      label: t('journal.root.composed'),
      stages: [{ name: 'narrow', width: 356, height: 411 }, { name: 'wide', width: 916, height: 336 }],
      Picture: picture('NightWindow'),
    },
  },
  sections: [
    {
      key: 'echoes',
      id: 'echoes',
      title: t('journal.landing.echoes.title', { break: '\n' }),
      paragraph: t('journal.landing.echoes.paragraph'),
      picture: frontPicture,
      features: [
        { title: t('journal.landing.echoes.wordsTitle'), text: t('journal.landing.echoes.wordsText') },
        { title: t('journal.landing.echoes.homeTitle'), text: t('journal.landing.echoes.homeText') },
        { title: t('journal.landing.echoes.freeTitle'), text: t('journal.landing.echoes.freeText') },
      ],
      line: t('journal.landing.echoes.line'),
    },
    {
      key: 'search',
      title: t('journal.landing.search.title', { break: '\n' }),
      paragraph: t('journal.landing.search.paragraph'),
      picture: {
        name: 'search',
        label: t('journal.root.composed'),
        stages: [{ name: 'narrow', width: 356, height: 348 }, { name: 'wide', width: 752, height: 362 }],
        Picture: picture('SearchSheet'),
      },
      features: [
        { title: t('journal.landing.search.deviceTitle'), text: t('journal.landing.search.deviceText') },
        { title: t('journal.landing.search.wordsTitle'), text: t('journal.landing.search.wordsText') },
        { title: t('journal.landing.search.webTitle'), text: t('journal.landing.search.webText') },
      ],
    },
    {
      key: 'page',
      title: t('journal.landing.page.title', { break: '\n' }),
      paragraph: t('journal.landing.page.paragraph'),
      picture: { name: 'write', label: t('journal.root.composed'), stages: SCENE_STAGES, Picture: picture('WriteBeat') },
      features: [
        { title: t('journal.landing.page.savesTitle'), text: t('journal.landing.page.savesText') },
        { title: t('journal.landing.page.offlineTitle'), text: t('journal.landing.page.offlineText') },
        { title: t('journal.landing.page.yesterdayTitle'), text: t('journal.landing.page.yesterdayText') },
      ],
    },
    {
      key: 'back',
      title: t('journal.landing.back.title', { break: '\n' }),
      paragraph: t('journal.landing.back.paragraph'),
      picture: { name: 'look_back', label: t('journal.landing.back.picture'), stages: SCENE_STAGES, Picture: picture('LookBackBeat') },
      features: [
        { title: t('journal.landing.back.weekTitle'), text: t('journal.landing.back.weekText') },
        { title: t('journal.landing.back.scalesTitle'), text: t('journal.landing.back.scalesText') },
        { title: t('journal.landing.back.praiseTitle'), text: t('journal.landing.back.praiseText') },
      ],
      line: t('journal.landing.back.line'),
    },
    {
      pair: [
        {
          key: 'quiet',
          title: t('journal.landing.quiet.title', { break: '\n' }),
          paragraph: t('journal.landing.quiet.paragraph'),
          features: [
            { title: t('journal.landing.quiet.streaksTitle'), text: t('journal.landing.quiet.streaksText') },
            { title: t('journal.landing.quiet.promptsTitle'), text: t('journal.landing.quiet.promptsText') },
            { title: t('journal.landing.quiet.shareTitle'), text: t('journal.landing.quiet.shareText') },
          ],
        },
        {
          key: 'data',
          title: t('journal.landing.data.title', { break: '\n' }),
          paragraph: t('journal.landing.data.paragraph'),
          features: [
            { title: t('journal.landing.data.localTitle'), text: t('journal.landing.data.localText') },
            { title: t('journal.landing.data.termsTitle'), text: t('journal.landing.data.termsText') },
            { title: t('journal.landing.data.doorTitle'), text: t('journal.landing.data.doorText') },
          ],
          link: { href: '/privacy.html', label: t('journal.landing.data.privacy'), to: 'privacy' },
        },
      ],
    },
    {
      key: 'keep',
      title: t('journal.landing.keep.title', { break: '\n' }),
      paragraph: t('journal.landing.keep.paragraph'),
      features: [
        { title: t('journal.landing.keep.leaveTitle'), text: t('journal.landing.keep.leaveText') },
        { title: t('journal.landing.keep.talkTitle'), text: t('journal.landing.keep.talkText'),
          link: { href: '/pricing.html', label: t('journal.landing.keep.pricing'), to: 'pricing' } },
        { title: t('journal.landing.keep.roomsTitle'), text: t('journal.landing.keep.roomsText') },
      ],
    },
  ],
  questionsTitle: t('journal.landing.questions.title'),
  questions: [
    { question: t('journal.landing.questions.findQuestion'), answer: t('journal.landing.questions.findAnswer') },
    { question: t('journal.landing.questions.rereadQuestion'), answer: t('journal.landing.questions.rereadAnswer') },
    { question: t('journal.landing.questions.missQuestion'), answer: t('journal.landing.questions.missAnswer') },
    { question: t('journal.landing.questions.replyQuestion'), answer: t('journal.landing.questions.replyAnswer') },
    { question: t('journal.landing.questions.privateQuestion'), answer: t('journal.landing.questions.privateAnswer') },
    { question: t('journal.landing.questions.freeQuestion'), answer: t('journal.landing.questions.freeAnswer') },
    { question: t('journal.landing.questions.aiQuestion'), answer: t('journal.landing.questions.aiAnswer') },
  ],
  closing: { line: t('journal.landing.closing'), link: write },
};
