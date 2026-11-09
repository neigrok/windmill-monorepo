export async function later() {
  const { t } = await import('./i18n/index.js');
  return t('fixture.greeting', { name: 'later' });
}
