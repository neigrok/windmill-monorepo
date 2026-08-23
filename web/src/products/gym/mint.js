// The client-minted id is the write's idempotency key: a resend must carry the same id.

export function mintId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return prefix + Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
