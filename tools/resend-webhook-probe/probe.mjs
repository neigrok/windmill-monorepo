// Is the Resend delivery webhook ARMED in production, or still dark?
//
// From outside you cannot tell: an unarmed endpoint and a wrongly-signed delivery both answer 401,
// which is the point — the door is dark rather than forgeable. The only honest check is to send a
// genuinely signed delivery and see a 200. That needs the signing secret, so this script reads it
// from the environment and never takes it as an argument: an argument lands in shell history and
// in the process list, where a webhook secret has no business being.
//
//   read -rs RESEND_WEBHOOK_SECRET && export RESEND_WEBHOOK_SECRET
//   node tools/resend-webhook-probe/probe.mjs https://windmill.works
//
// SAFETY: the delivery it sends is a PERMANENT bounce for a random address at .invalid — a domain
// RFC 2606 reserves so it can never resolve and can never belong to an account. The handler answers
// 200 for an address nobody owns and writes nothing (deliberately not a 404, which would turn the
// endpoint into an account-existence oracle). So a pass proves the signature verified end to end
// while changing no state. Never point this at a real address: a valid signed bounce is exactly
// what stops that mailbox's mail, and nothing in the product lifts a suppression yet.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const origin = process.argv[2] ?? 'https://windmill.works';
const configured = process.env.RESEND_WEBHOOK_SECRET;
if (!configured) {
  console.error('RESEND_WEBHOOK_SECRET is not set in this shell. See the header of this file.');
  process.exit(2);
}

// The server trims surrounding whitespace and matching quotes before the whsec_ test, so a value
// pasted with a stray newline or wrapped in quotes still works. Mirror that here, or this probe
// reports a false 401 for a secret production is perfectly happy with.
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

// Guard the guard: prove the probe can also produce a FAILING signature, so a 200 above means the
// server actually checked something rather than waving everything through.
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
