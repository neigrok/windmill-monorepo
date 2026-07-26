// Settings §05 · Feedback. The one-line door out to the team, so a signed-in account that
// hits something rough can say so without leaving the page. Same FeedbackDialog the landing
// footer opens — this section just owns its open state.

import React, { useState } from 'react';
import { Button } from '../../design-system';
import { FeedbackDialog } from '../feedback/FeedbackDialog.jsx';
import { Section, styles } from './Section.jsx';

export function FeedbackSection() {
  const [open, setOpen] = useState(false);
  return (
    <Section title="Feedback">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>Send feedback</Button>
        <span style={styles.calmLine}>Tell us what's working or what's broken — it goes straight to the team.</span>
      </div>
      <FeedbackDialog open={open} onClose={() => setOpen(false)} />
    </Section>
  );
}

export default FeedbackSection;
