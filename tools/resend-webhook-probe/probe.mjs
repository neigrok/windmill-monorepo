// Is the Resend delivery webhook armed? Sends a genuinely signed delivery and looks for a 200; an
// unarmed endpoint and a wrongly-signed one both answer 401. The secret comes from the environment,
// never an argument, which would land in shell history and the process list.
//
//   read -rs RESEND_WEBHOOK_SECRET && export RESEND_WEBHOOK_SECRET
//   node tools/resend-webhook-probe/probe.mjs https://windmill.works
//
// SAFETY: never point this at a real address — a valid signed bounce stops that mailbox's mail. The
// delivery below is a bounce for a random .invalid address, which can never belong to an account.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const origin = process.argv[2] ?? 'https://windmill.works';
const configured = process.env.RESEND_WEBHOOK_SECRET;
if (!configured) {
  console.error('RESEND_WEBHOOK_SECRET is not set in this shell. See the header of this file.');
  process.exit(2);
}

// The server trims surrounding whitespace and matching quotes before the whsec_ test; mirror that
// here or the probe reports a false 401.
const trimmed = configured.trim().replace(/^(['"])(.*)\1$/s, '$2');
const key = Buffer.from(trimmed.startsWith('whsec_') ? trimmed.slice('whsec_'.length) : trimmed, 'base64');

const address = `probe-${randomBytes(6).toString('hex')}@nobody.invalid`;
const body = JSON.stringify({
  type: 'email.bounced',
  data: { to: [address], bounce: { type: 'Permanent', subType: 'General' } },
});
const id = `msg_${randomBytes(12).toString('hex')}`;
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');

const response = await fetch(`${origin}/v1/resend/webhook`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${signature}`,
  },
  body,
});
const text = (await response.text()).slice(0, 200);

console.log(`POST ${origin}/v1/resend/webhook -> ${response.status} ${text}`);
if (response.status === 200) {
  console.log(`ARMED. The signature verified, and ${address} belongs to nobody, so nothing was written.`);
} else if (response.status === 401) {
  console.log('DARK or MISMATCHED. Either RESEND_WEBHOOK_SECRET never reached the container (deploy'
    + ' after setting it), or the value here is not the one that endpoint was deployed with.');
} else if (response.status === 404) {
  console.log('The route is not deployed at all — this origin is running a build from before it landed.');
} else {
  console.log('Unexpected. A verified delivery should never 5xx; anything else is worth reading the logs for.');
}

// Control: a wrong key must be refused, or the 200 above proves nothing.
const forged = createHmac('sha256', Buffer.from('not-the-key')).update(`${id}.${timestamp}.${body}`).digest('base64');
if (!timingSafeEqual(Buffer.from(forged), Buffer.from(signature))) {
  const refused = await fetch(`${origin}/v1/resend/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${forged}`,
    },
    body,
  });
  console.log(`control: the same delivery under a WRONG key -> ${refused.status} (must be 401)`);
}
