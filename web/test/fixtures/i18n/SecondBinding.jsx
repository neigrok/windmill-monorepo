import { t, t as tr } from './i18n/index.js';

export const SecondBinding = () => <p>{t('fixture.headline')}{tr('fixture.greeting', { name: 'two' })}</p>;
