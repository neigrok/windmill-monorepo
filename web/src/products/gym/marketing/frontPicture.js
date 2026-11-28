// Gym's picture on the front page, declared once: the brand root's section draws it, and the landing draws it again.
// Each stage is the picture's own drawn size; the shell holds the frame to one before the picture's chunk arrives. `name`
// is what the picture's event calls it, on either page.

import { lazy } from 'react';
import { t } from '../i18n/entry/index.js';

export const frontPicture = {
  name: 'root',
  label: t('gym.root.composed'),
  stages: [{ name: 'narrow', width: 356, height: 532 }, { name: 'wide', width: 552, height: 510 }],
  Picture: lazy(() => import('./RootPicture.jsx').then((m) => ({ default: m.GymPicture }))),
};
