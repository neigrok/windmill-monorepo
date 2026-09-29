// §9.1 credentials: what a request sends, read from its raw headers, and the principal the endpoints
// serve it as. Pull, push and hello take that principal as `account` and `credential`.

import { isAccountId } from '../core/wire.js';

export const SESSION_COOKIE = 'wm_session';

const BEARER = /^Bearer ([^\s]+)$/i;

// Header names compare in ASCII case only: a name holding any other letter names another header.
const asciiLower = (text) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

// RFC 6265 whitespace, space and tab, and nothing else.
const trimWsp = (text) => text.replace(/^[ \t]+|[ \t]+$/g, '');

// Every credential a request sends, from its headers as received: [name, value] pairs with every
// occurrence kept. Each Authorization header is one, whatever its shape; each Cookie piece named the
// session cookie is one, a bare name with no `=` included. A cookie's token is its value with only
// space and tab trimmed around it: no quote is stripped and nothing is unescaped. A credential whose
// shape is not a token carries a null token.
function sentCredentials(headers) {
  const sent = [];
  for (const [name, value] of headers) {
    const header = asciiLower(name);
    if (header === 'authorization') sent.push({ kind: 'authorization', token: BEARER.exec(value)?.[1] ?? null });
    if (header !== 'cookie') continue;
    for (const piece of value.split(';')) {
      const at = piece.indexOf('=');
      const cookie = trimWsp(at === -1 ? piece : piece.slice(0, at));
      if (cookie !== SESSION_COOKIE) continue;
      const token = at === -1 ? '' : trimWsp(piece.slice(at + 1));
      sent.push({ kind: 'cookie', token: token === '' ? null : token });
    }
  }
  return sent;
}

// The principal a request is served as, given `sessions`, each live session's token to its account:
// {account: null} when it sends no credential (anonymous), {account} when what it sends resolves, and
// {account: null, credential: 'unresolved'} otherwise: two Authorization headers or two session cookies,
// a credential of another shape, a token no live session holds, or a cookie and a header whose accounts
// differ.
export function principalOf(headers, sessions) {
  const sent = sentCredentials(headers);
  if (sent.length === 0) return { account: null };
  const unresolved = { account: null, credential: 'unresolved' };
  if (new Set(sent.map((credential) => credential.kind)).size !== sent.length) return unresolved;
  const accounts = sent.map(({ token }) => (token !== null && Object.hasOwn(sessions, token) ? sessions[token] : null));
  if (accounts.includes(null) || new Set(accounts).size !== 1) return unresolved;
  return { account: accounts[0] };
}

// A sent credential fails, answered 401, when it resolves to no account (`credential: 'unresolved'`) or
// to an account id outside §9.1's form. A null account with no credential is anonymous.
export function credentialFails(account, credential) {
  return credential === 'unresolved' || (account !== null && !isAccountId(account));
}
