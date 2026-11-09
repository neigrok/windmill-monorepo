import { t } from '/test/fixtures/i18n/i18n/index.js';

export const RootAbsolute = () => <p>{t('fixture.greeting', { name: 'root' })}</p>;
