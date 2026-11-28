// Roadmap's picture on the front page, declared once: the brand root's section draws it, and the landing draws it again.
// Each stage is the picture's own drawn size; the shell holds the frame to one before the picture's chunk arrives. `name`
// is what the picture's event calls it, on either page.

import { lazy } from 'react';
import { t } from '../i18n/entry/index.js';

export const frontPicture = {
  name: 'root',
  label: t('roadmap.scene.composed'),
  stages: [{ name: 'narrow', width: 356, height: 364 }, { name: 'column', width: 720, height: 584 }, { name: 'row', width: 1080, height: 500 }],
  Picture: lazy(() => import('./RootPicture.jsx').then((m) => ({ default: m.RoadmapPicture }))),
};
