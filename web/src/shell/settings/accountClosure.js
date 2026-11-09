// The consent copy for closing an account; product names arrive from the registry.

import { joinLabels } from '../products.js';
import { t } from '../i18n/settings/index.js';

export function closingDeal(productLabels) {
  return [
    t('shell.closeAccount.dealSignsOut'),
    t('shell.closeAccount.dealWholeAccount', { products: joinLabels(productLabels) }),
    t('shell.closeAccount.dealDeviceData'),
    t('shell.closeAccount.dealExport'),
    t('shell.closeAccount.dealGrace'),
  ];
}
