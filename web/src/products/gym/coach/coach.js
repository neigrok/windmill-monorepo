import { createContext } from 'react';
import { t } from '../i18n/index.js';

export const COACH_TITLE = t('gym.coach.title');

// Which form the conversation stands in: the room (08W), or Coach over a workout (WD7), whose conversation drops the day
// stamp, takes the board's smaller type and composer, and decides a card with design-system Buttons.
export const CoachForm = createContext('room');
