import { t } from './i18n/index.js';
import { t as entryT } from './i18n/entry/index.js';

export const TwoImports = () => <p>{t('fixture.headline')}{entryT('fixture.title')}</p>;
