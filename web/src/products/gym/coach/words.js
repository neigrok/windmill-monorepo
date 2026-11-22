import prompt from '../../../../../packages/api-contract/gym/coach/prompt.md?raw';
import firstContent from '../../../../../packages/api-contract/gym/coach/first-content.json' with { type: 'json' };
import refusals from '../../../../../packages/api-contract/gym/coach/refusals.json' with { type: 'json' };

// The words Coach's model reads in a turn: the contract's own files (packages/api-contract/gym/coach/README.md),
// which every app ships as they are.
export const COACH_WORDS = Object.freeze({ prompt, firstContent, refusals });
