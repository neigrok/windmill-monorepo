// The consent copy for closing an account; product names arrive from the registry.

import { joinLabels } from '../products.js';

export function closingDeal(productLabels) {
  return [
    'Every device signs out and every connected tool loses its access, immediately.',
    `It closes the whole account, not one room — ${joinLabels(productLabels)} alike.`,
    'Anything held only on this device stays on this device.',
    'Export what you want to keep first — every export Windmill has is on this page.',
    'Signing in again is the undo, and it brings the account back whole.',
  ];
}
