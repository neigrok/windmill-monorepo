// THE ID MINT. Every gym write carries a client-minted id, and the id IS the idempotency key: a
// create that times out and is sent again must be the same document arriving twice, never two
// documents with one name. The prefix says what the id names — ses_ / set_ / rt_ / ex_ / thr_ — and
// the sixteen hex characters behind it are the device's own randomness, the same shape the phones
// mint (Ids.session()/set()/routine()/exercise(), apps/ios + apps/android).
//
// `thr_` IS THE ONE THAT NAMES SOMETHING THAT IS NOT A WRITE YET (§O). A conversation's id is minted
// before the first question is sent and reused for every question after it, so the id is what makes
// a follow-up land in the thread a lifter is reading rather than opening a second one.

export function mintId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return prefix + Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
