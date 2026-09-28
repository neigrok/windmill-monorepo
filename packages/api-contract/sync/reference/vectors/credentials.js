// envelope/credentials.json: §9.1 the principal a request is served as, from its raw headers as
// received, every occurrence kept. The expected principal is the `account` and `credential` pull, push
// and hello take.

import { principalOf } from '../server/credentials.js';
import { vector } from './fixtures.js';

const SESSIONS = { 's-ann': 'A', 's-ann-phone': 'A', 's-bob': 'B' };

function served(name, headers) {
  return vector(name, { headers, sessions: SESSIONS }, { principal: principalOf(headers, SESSIONS) });
}

function credentials() {
  return [
    served('no credential is anonymous', [['Accept', 'application/json']]),
    served('cookies other than the session cookie are no credential', [['Cookie', 'theme=dark; lang=en']]),
    served('a session cookie that resolves serves its account', [['Cookie', 'theme=dark; wm_session=s-ann']]),
    served('a Bearer Authorization header that resolves serves its account', [['Authorization', 'Bearer s-bob']]),
    served('header names compare case-insensitively', [['authorization', 'Bearer s-bob']]),
    served('a session cookie no live session holds does not resolve', [['Cookie', 'wm_session=s-gone']]),
    served('a bare session cookie with no = is a credential that does not resolve', [['Cookie', 'theme=dark; wm_session']]),
    served('an empty session cookie is a credential that does not resolve', [['Cookie', 'wm_session=']]),
    served('a session cookie\'s token is its value verbatim: a quoted token does not resolve', [['Cookie', 'wm_session="s-ann"']]),
    served('a session cookie\'s token is its value verbatim: an escaped token does not resolve', [['Cookie', 'wm_session=s%2Dann']]),
    served('two session cookies in one header do not resolve, even when both name the account', [['Cookie', 'wm_session=s-ann; wm_session=s-ann']]),
    served('two session cookies in two Cookie headers do not resolve', [['Cookie', 'wm_session=s-ann'], ['Cookie', 'wm_session=s-bob']]),
    served('two Authorization headers do not resolve, even when both name the account', [['Authorization', 'Bearer s-ann'], ['Authorization', 'Bearer s-ann-phone']]),
    served('an Authorization header of another shape does not resolve', [['Authorization', 'Basic czphbm4=']]),
    served('a Bearer header without a token does not resolve', [['Authorization', 'Bearer']]),
    served('a cookie and a header naming one account serve it', [['Cookie', 'wm_session=s-ann'], ['Authorization', 'Bearer s-ann-phone']]),
    served('a cookie and a header naming different accounts do not resolve', [['Cookie', 'wm_session=s-ann'], ['Authorization', 'Bearer s-bob']]),
    served('a malformed cookie beside a header that resolves does not resolve', [['Cookie', 'wm_session'], ['Authorization', 'Bearer s-ann']]),
  ];
}

export function files() {
  return { 'envelope/credentials.json': credentials() };
}
