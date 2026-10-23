// The consent copy for closing an account; product names arrive from the registry.

import { joinLabels } from '../products.js';

export function closingDeal(productLabels) {
  return [
    'Every device signs out and every connected tool loses its access, immediately.',
    `It closes the whole account, not one room — ${joinLabels(productLabels)} alike.`,
    'This account’s data on this device is discarded, including changes that haven’t reached the account.',
    'Export what you want to keep first — every export Windmill has is on this page.',
    'For 30 days, you can sign in again to bring it all back. After that, it is deleted for good.',
  ];
}
