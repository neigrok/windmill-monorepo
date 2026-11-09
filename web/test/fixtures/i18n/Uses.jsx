import { t } from './i18n/index.js';

export function Uses({ name, count, keys }) {
  return (
    <section aria-label={t('fixture.greeting', { name })}>
      <p>{t('fixture.greeting', { name, extra: count })}</p>
      <p>{t('fixture.steps')}</p>
      <p>{t('fixture.absent')}</p>
      <p>{t('Fixture.badShape')}</p>
      <p>{t('fixture.broken', { count })}</p>
      <p>{keys.map(t)}</p>
      <p>{t(`fixture.${name}`)}</p>
      <p>{t('fixture.roomOnly')}</p>
      <p>{t('fixture.landingRoomOnly')}</p>
    </section>
  );
}
