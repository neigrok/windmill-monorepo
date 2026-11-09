
import React, { useState } from 'react';
import { Button } from '../../design-system';
import { FeedbackDialog } from '../feedback/FeedbackDialog.jsx';
import { Section, styles } from './Section.jsx';
import { t } from '../i18n/index.js';

export function FeedbackSection() {
  const [open, setOpen] = useState(false);
  return (
    <Section title={t('shell.feedback.label')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>{t('shell.feedback.title')}</Button>
        <span style={styles.calmLine}>{t('shell.feedback.lede')}</span>
      </div>
      <FeedbackDialog open={open} onClose={() => setOpen(false)} />
    </Section>
  );
}

export default FeedbackSection;
