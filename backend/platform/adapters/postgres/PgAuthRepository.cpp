#include "platform/adapters/postgres/PgAuthRepository.h"

#include "platform/adapters/postgres/PgPool.h"

#include <pqxx/pqxx>

namespace wm {

PgAuthRepository::PgAuthRepository(std::shared_ptr<PgPool> pool, std::shared_ptr<PgAccountFootprint> footprint,
                                   std::vector<AccountErasure> productErasures)
    : pool_(std::move(pool)), footprint_(std::move(footprint)), productErasures_(std::move(productErasures)) {}

namespace {
// A users row → User, carrying the close and the instant it turns final (null deleted_at → a live account).
// `const auto&` for the row: pqxx names the row type differently across versions (row vs row_ref),
// and deducing it keeps the build portable macOS↔Linux.
std::optional<UnixMs> msOf(const auto& field) {
  if (field.is_null()) return std::nullopt;
  return static_cast<UnixMs>(field.template as<long long>());
}
User userFrom(const auto& row) {
  return User{UserId{row["id"].template as<std::string>()}, Email{row["email"].template as<std::string>()},
              row["name"].template as<std::string>(), msOf(row["deleted_ms"]), msOf(row["closes_ms"])};
}
const char* kUserColumns =
    "id::text, email::text, name, (extract(epoch from deleted_at) * 1000)::bigint AS deleted_ms, "
    "(extract(epoch from closes_at) * 1000)::bigint AS closes_ms";
// The token_hash of every row a DELETE … RETURNING token_hash dropped.
std::vector<std::string> digestsOf(const pqxx::result& rows) {
  std::vector<std::string> digests;
  for (const auto& row : rows) digests.push_back(row["token_hash"].template as<std::string>());
  return digests;
}
}

std::optional<User> PgAuthRepository::findUserByEmail(const Email& email) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT " + std::string(kUserColumns) + " FROM users WHERE email = $1", email.value);
  if (rows.empty()) return std::nullopt;
  return userFrom(rows[0]);
}

std::optional<User> PgAuthRepository::findUserById(const UserId& id) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT " + std::string(kUserColumns) + " FROM users WHERE id = $1::uuid", id.str());
  if (rows.empty()) return std::nullopt;
  return userFrom(rows[0]);
}

User PgAuthRepository::createUser(const Email& email, const std::string& name) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  // Two first sign-ins at one address race here; the loser answers the account the winner made.
  pqxx::result rows = txn.exec_params(
      "INSERT INTO users (id, email, name) VALUES (gen_random_uuid(), $1, $2) "
      "ON CONFLICT (email) DO UPDATE SET email = users.email "
      "RETURNING " + std::string(kUserColumns),
      email.value, name);
  txn.commit();
  return userFrom(rows[0]);
}

void PgAuthRepository::updateName(const UserId& userId, const std::string& name) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params("UPDATE users SET name = $2 WHERE id = $1::uuid", userId.str(), name);
  txn.commit();
}

void PgAuthRepository::markUserDeleted(const UserId& userId, UnixMs now, UnixMs closesAt) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params("UPDATE users SET deleted_at = to_timestamp($2::double precision / 1000.0), "
                  "closes_at = to_timestamp($3::double precision / 1000.0) WHERE id = $1::uuid",
                  userId.str(), static_cast<long long>(now), static_cast<long long>(closesAt));
  txn.commit();
}

bool PgAuthRepository::reviveUser(const UserId& userId, UnixMs now) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  const pqxx::result revived = txn.exec_params(
      "UPDATE users SET deleted_at = NULL, closes_at = NULL WHERE id = $1::uuid AND deleted_at IS NOT NULL "
      "AND (closes_at IS NULL OR closes_at > to_timestamp($2::double precision / 1000.0))",
      userId.str(), static_cast<long long>(now));
  txn.commit();
  return revived.affected_rows() != 0;
}

std::vector<std::string> PgAuthRepository::deleteUser(const UserId& userId) {
  // The row is locked first, so no session is inserted for it between the two deletes: every session the account held
  // is one this answers.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params("SELECT 1 FROM users WHERE id = $1::uuid FOR UPDATE", userId.str());
  const pqxx::result sessions = txn.exec_params("DELETE FROM sessions WHERE user_id = $1::uuid RETURNING token_hash", userId.str());
  txn.exec_params("DELETE FROM users WHERE id = $1::uuid", userId.str());
  txn.commit();
  return digestsOf(sessions);
}

std::vector<UserId> PgAuthRepository::finalClosedAccounts(UnixMs now, int limit) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  const pqxx::result rows = txn.exec_params(
      "SELECT id::text FROM users WHERE deleted_at IS NOT NULL "
      "AND closes_at <= to_timestamp($1::double precision / 1000.0) ORDER BY closes_at, id LIMIT $2",
      static_cast<long long>(now), limit);
  std::vector<UserId> accounts;
  for (const auto& row : rows) accounts.push_back(UserId{row[0].template as<std::string>()});
  return accounts;
}

bool PgAuthRepository::eraseAccount(const UserId& userId, UnixMs now) {
  std::vector<std::vector<std::string>> erasedKeys(productErasures_.size());
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    // The lock re-reads the row once it is held, so a revive that committed first leaves nothing to erase.
    const pqxx::result locked = txn.exec_params(
        "SELECT email::text FROM users WHERE id = $1::uuid AND deleted_at IS NOT NULL "
        "AND closes_at <= to_timestamp($2::double precision / 1000.0) FOR UPDATE",
        userId.str(), static_cast<long long>(now));
    if (locked.empty()) return false;
    const std::string email = locked[0][0].as<std::string>();

    for (std::size_t product = 0; product < productErasures_.size(); ++product)
      for (const std::string& statement : productErasures_[product].statements) {
        const pqxx::result erased = txn.exec_params(statement, userId.str());
        if (erased.columns() == 0) continue;
        for (const auto& row : erased) erasedKeys[product].push_back(row[0].template as<std::string>());
      }
    // The engine's rows reference the account without a cascade; its spent records hang off its scopes.
    txn.exec_params("DELETE FROM sync_spent WHERE scope_key IN (SELECT key FROM sync_scopes WHERE owner = $1::uuid)",
                    userId.str());
    txn.exec_params("DELETE FROM sync_scopes WHERE owner = $1::uuid", userId.str());
    txn.exec_params("DELETE FROM sync_replicas WHERE account = $1::uuid", userId.str());
    txn.exec_params("DELETE FROM sync_requests WHERE account = $1::uuid", userId.str());
    txn.exec_params("DELETE FROM org_members WHERE user_id = $1::uuid", userId.str());
    // What the person did and said, and the errors they met. Feedback left signed out is theirs by the
    // address typed into it; an open account's own feedback stays, whatever address it typed.
    txn.exec_params("DELETE FROM events WHERE user_id = $1::uuid", userId.str());
    txn.exec_params("DELETE FROM feedback WHERE user_id = $1::uuid OR (user_id IS NULL AND lower(email) = lower($2))",
                    userId.str(), email);
    txn.exec_params("DELETE FROM server_errors WHERE actor = $1::uuid", userId.str());
    // Billing's mirror, by account and by the address that bridges to a Paddle customer.
    txn.exec_params("DELETE FROM paddle_subscriptions WHERE user_id = $1::uuid", userId.str());
    txn.exec_params("DELETE FROM paddle_customers WHERE email = $1", email);
    // Everything else references the row and cascades with it: sessions, doors, keys, grants, reminders, journal, gym.
    txn.exec_params("DELETE FROM users WHERE id = $1::uuid", userId.str());
    txn.commit();
  }
  for (std::size_t product = 0; product < productErasures_.size(); ++product)
    if (productErasures_[product].committed) productErasures_[product].committed(erasedKeys[product]);
  return true;
}

std::optional<UserId> PgAuthRepository::findIdentity(Provider provider, const std::string& subject) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT user_id::text FROM user_identities WHERE provider = $1 AND subject = $2",
      toString(provider), subject);
  if (rows.empty()) return std::nullopt;
  return UserId{rows[0][0].as<std::string>()};
}

void PgAuthRepository::bindIdentity(Provider provider, const std::string& subject, const UserId& userId,
                                    const std::string& emailAtLink) {
  // DO UPDATE, not DO NOTHING: re-binding is the door following its account rather than overwriting one.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params(
      "INSERT INTO user_identities (provider, subject, user_id, email_at_link) "
      "VALUES ($1, $2, $3::uuid, $4) "
      "ON CONFLICT (provider, subject) DO UPDATE SET user_id = excluded.user_id, "
      "email_at_link = excluded.email_at_link",
      toString(provider), subject, userId.str(), emailAtLink);
  txn.commit();
}

bool PgAuthRepository::tryBindIdentity(const ProviderIdentity& identity, const UserId& userId) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  const auto rows = txn.exec_params(
      "INSERT INTO user_identities(provider,subject,user_id,email_at_link,relay) VALUES('apple',$1,$2::uuid,$3,$4) "
      "ON CONFLICT(provider,subject) DO UPDATE SET user_id=excluded.user_id "
      "WHERE user_identities.user_id=excluded.user_id RETURNING user_id",
      identity.subject, userId.str(), identity.email.value,
      trustOf(identity) == AddressTrust::appOnly);
  txn.commit();
  return !rows.empty();
}

std::optional<User> PgAuthRepository::signInApple(const ProviderIdentity& identity, const UserId& userId,
    const std::string& sessionDigest, UnixMs expiresAt, const std::string& userAgent,
    const std::string& ip, UnixMs now) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  if (txn.exec_params("SELECT id FROM users WHERE id=$1::uuid FOR UPDATE", userId.str()).empty()) return std::nullopt;
  const auto bound = txn.exec_params(
      "INSERT INTO user_identities(provider,subject,user_id,email_at_link,relay) VALUES('apple',$1,$2::uuid,$3,$4) "
      "ON CONFLICT(provider,subject) DO UPDATE SET user_id=excluded.user_id "
      "WHERE user_identities.user_id=excluded.user_id RETURNING user_id",
      identity.subject, userId.str(), identity.email.value, trustOf(identity) == AddressTrust::appOnly);
  if (bound.empty()) return std::nullopt;
  const auto users = txn.exec_params("UPDATE users SET deleted_at=NULL, closes_at=NULL WHERE id=$1::uuid RETURNING " + std::string(kUserColumns), userId.str());
  txn.exec_params("INSERT INTO sessions(token_hash,user_id,expires_ms,user_agent,ip,last_seen_ms) VALUES($1,$2::uuid,$3,$4,$5,$6)",
      sessionDigest, userId.str(), static_cast<long long>(expiresAt), userAgent, ip, static_cast<long long>(now));
  txn.commit();
  return userFrom(users[0]);
}

std::vector<SignInMethod> PgAuthRepository::signInMethods(const UserId& userId) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  const auto rows = txn.exec_params(
      "SELECT provider,email_at_link,relay FROM user_identities WHERE user_id=$1::uuid ORDER BY provider,created_at,subject",
      userId.str());
  std::vector<SignInMethod> methods;
  for (const auto& row : rows) {
    const Email email{row["email_at_link"].as<std::string>()};
    methods.push_back({*parseProvider(row["provider"].as<std::string>()), email.value,
                       row["relay"].as<bool>() || isPrivateRelay(email)});
  }
  return methods;
}

bool PgAuthRepository::unbindIdentity(Provider provider, const UserId& userId) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  const auto rows = txn.exec_params("DELETE FROM user_identities WHERE provider=$1 AND user_id=$2::uuid",
                                    toString(provider), userId.str());
  txn.commit();
  return rows.affected_rows() != 0;
}

std::optional<std::vector<std::string>> PgAuthRepository::takeOverIdentity(
    const ProviderIdentity& identity, const UserId& from, const UserId& to) {
  if (!footprint_ || from == to) return std::nullopt;
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  // Account locks precede the footprint recheck; foreign keys and non-FK writers hold key-share locks.
  const auto accounts = txn.exec_params("SELECT id FROM users WHERE id IN ($1::uuid,$2::uuid) ORDER BY id FOR UPDATE", from.str(), to.str());
  if (accounts.size() != 2 || footprint_->lockAndCheck(txn, from)) return std::nullopt;
  const auto moved = txn.exec_params(
      "UPDATE user_identities SET user_id=$3::uuid WHERE provider='apple' AND subject=$1 AND user_id=$2::uuid RETURNING user_id",
      identity.subject, from.str(), to.str());
  if (moved.empty()) return std::nullopt;
  const auto sessions = txn.exec_params("DELETE FROM sessions WHERE user_id=$1::uuid RETURNING token_hash", from.str());
  txn.exec_params("DELETE FROM users WHERE id=$1::uuid", from.str());
  txn.commit();
  return digestsOf(sessions);
}

void PgAuthRepository::insertAppleTicket(const std::string& digest, const StoredAppleTicket& ticket) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params("INSERT INTO apple_tickets(token_hash,subject,email,relay,name,expires_ms) VALUES($1,$2,$3,$4,$5,$6)",
      digest, ticket.identity.subject, ticket.identity.email.value, ticket.identity.relayEmail,
      ticket.identity.name, static_cast<long long>(ticket.expiresAt));
  txn.commit();
}

std::optional<StoredAppleTicket> PgAuthRepository::findAppleTicket(const std::string& digest, UnixMs now) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  const auto rows = txn.exec_params(
      "SELECT subject,email,relay,name,expires_ms FROM apple_tickets WHERE token_hash=$1 AND consumed_ms IS NULL AND expires_ms>$2",
      digest, static_cast<long long>(now));
  if (rows.empty()) return std::nullopt;
  const auto& row = rows[0];
  return StoredAppleTicket{{Provider::apple, row["subject"].as<std::string>(), Email{row["email"].as<std::string>()},
      row["name"].as<std::string>(), true, row["relay"].as<bool>()}, static_cast<UnixMs>(row["expires_ms"].as<long long>())};
}

AppleTicketResult PgAuthRepository::redeemAppleTicket(const std::string& digest, UnixMs now,
    const std::optional<UserId>& target, const std::string& name, const std::string& sessionDigest,
    UnixMs expiresAt, const std::string& userAgent, const std::string& ip,
    const std::string& codeLinkDigest) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  const auto subjects = txn.exec_params("SELECT subject FROM apple_tickets WHERE token_hash=$1", digest);
  if (subjects.empty()) return {AppleTicketOutcome::expired, std::nullopt};
  // Every redemption takes the subject mutex before locking any ticket row.
  txn.exec_params("SELECT pg_advisory_xact_lock(hashtext('apple-ticket'),hashtext($1))", subjects[0][0].as<std::string>());
  const auto tickets = txn.exec_params(
      "SELECT subject,email,relay FROM apple_tickets WHERE token_hash=$1 AND consumed_ms IS NULL AND expires_ms>$2 FOR UPDATE",
      digest, static_cast<long long>(now));
  if (tickets.empty()) return {AppleTicketOutcome::expired, std::nullopt};
  const auto& ticket = tickets[0];
  const bool linking = !codeLinkDigest.empty();
  if (linking) {
    const auto code = txn.exec_params(
        "UPDATE magic_links SET consumed_ms=$2 WHERE token_hash=$1 AND consumed_ms IS NULL "
        "AND expires_ms>$2 AND attempts<$3 RETURNING token_hash",
        codeLinkDigest, static_cast<long long>(now), AuthPolicy::maxCodeAttempts);
    if (code.empty()) return {AppleTicketOutcome::codeRefused, std::nullopt};
    if (!target) {
      txn.commit();
      return {AppleTicketOutcome::noAccount, std::nullopt};
    }
  }
  bool created = false;
  std::string account;
  if (target) {
    account = target->str();
    const auto users = txn.exec_params("SELECT id FROM users WHERE id=$1::uuid FOR UPDATE", account);
    if (users.empty()) {
      if (linking) txn.commit();
      return {AppleTicketOutcome::noAccount, std::nullopt};
    }
  } else {
    const auto added = txn.exec_params(
        "INSERT INTO users(id,email,name) VALUES(gen_random_uuid(),$1,$2) ON CONFLICT(email) DO NOTHING RETURNING id::text",
        ticket["email"].as<std::string>(), name);
    if (added.empty()) {
      txn.exec_params("UPDATE apple_tickets SET consumed_ms=$2 WHERE token_hash=$1", digest, static_cast<long long>(now));
      txn.commit();
      return {AppleTicketOutcome::expired, std::nullopt};
    }
    created = true;
    account = added[0][0].as<std::string>();
  }
  const auto bound = txn.exec_params(
      "INSERT INTO user_identities(provider,subject,user_id,email_at_link,relay) VALUES('apple',$1,$2::uuid,$3,$4) "
      "ON CONFLICT(provider,subject) DO UPDATE SET user_id=excluded.user_id "
      "WHERE user_identities.user_id=excluded.user_id RETURNING user_id",
      ticket["subject"].as<std::string>(), account, ticket["email"].as<std::string>(), ticket["relay"].as<bool>());
  if (bound.empty()) {
    if (linking) txn.commit();
    return {AppleTicketOutcome::identityTaken, std::nullopt};
  }
  const auto users = txn.exec_params("UPDATE users SET deleted_at=NULL, closes_at=NULL WHERE id=$1::uuid RETURNING " + std::string(kUserColumns), account);
  if (users.empty()) return {AppleTicketOutcome::noAccount, std::nullopt};
  txn.exec_params("INSERT INTO sessions(token_hash,user_id,expires_ms,user_agent,ip,last_seen_ms) VALUES($1,$2::uuid,$3,$4,$5,$6)",
      sessionDigest, account, static_cast<long long>(expiresAt), userAgent, ip, static_cast<long long>(now));
  if (created)
    txn.exec_params("UPDATE apple_tickets SET consumed_ms=$2 WHERE subject=$1 AND consumed_ms IS NULL",
        ticket["subject"].as<std::string>(), static_cast<long long>(now));
  else
    txn.exec_params("UPDATE apple_tickets SET consumed_ms=$2 WHERE token_hash=$1", digest, static_cast<long long>(now));
  txn.commit();
  return {AppleTicketOutcome::completed, userFrom(users[0]), created};
}

void PgAuthRepository::moveIdentities(const UserId& from, const UserId& to) {
  // The destination may already hold a door for the same provider; the (provider, subject) pair is
  // the key and only the loser's own doors move, so a collision is impossible.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params("UPDATE user_identities SET user_id = $2::uuid WHERE user_id = $1::uuid",
                  from.str(), to.str());
  txn.commit();
}

void PgAuthRepository::insertLink(const std::string& digest, const std::string& codeDigest,
                                  const Email& email, UnixMs createdAt, UnixMs expiresAt,
                                  const std::string& forkSource) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params(
      "INSERT INTO magic_links (token_hash, code_hash, email, created_ms, expires_ms, fork_source) "
      "VALUES ($1, nullif($2, ''), $3, $4, $5, nullif($6, ''))",
      digest, codeDigest, email.value, static_cast<long long>(createdAt),
      static_cast<long long>(expiresAt), forkSource);
  txn.commit();
}

int PgAuthRepository::countRecentLinks(const Email& email, UnixMs since) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT count(*) FROM magic_links "
      "WHERE email = $1 AND consumed_ms IS NULL AND created_ms >= $2",
      email.value, static_cast<long long>(since));
  return rows[0][0].as<int>();
}

std::optional<StoredLink> PgAuthRepository::findLink(const std::string& digest) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT email::text, consumed_ms, expires_ms, coalesce(fork_source, '') AS fork_source "
      "FROM magic_links WHERE token_hash = $1", digest);
  if (rows.empty()) return std::nullopt;

  const auto& row = rows[0];
  return StoredLink{Email{row["email"].as<std::string>()}, !row["consumed_ms"].is_null(),
                    static_cast<UnixMs>(row["expires_ms"].as<long long>()),
                    row["fork_source"].as<std::string>()};
}

std::optional<StoredSignInCode> PgAuthRepository::findLiveCode(const Email& email, UnixMs now,
                                                               int maxAttempts) {
  // Newest live row wins — a resend supersedes the code before it.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT token_hash, code_hash, coalesce(fork_source, '') AS fork_source "
      "FROM magic_links "
      "WHERE email = $1 AND code_hash IS NOT NULL AND consumed_ms IS NULL "
      "AND expires_ms > $2 AND attempts < $3 "
      "ORDER BY created_ms DESC LIMIT 1",
      email.value, static_cast<long long>(now), maxAttempts);
  if (rows.empty()) return std::nullopt;

  const auto& row = rows[0];
  return StoredSignInCode{row["token_hash"].as<std::string>(), row["code_hash"].as<std::string>(),
                          row["fork_source"].as<std::string>()};
}

int PgAuthRepository::spendCodeAttempt(const std::string& digest, int maxAttempts) {
  // One statement, gated in the WHERE: racing wrong guesses each pay for themselves, and the count
  // can only climb to the cap, never past it.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "UPDATE magic_links SET attempts = attempts + 1 "
      "WHERE token_hash = $1 AND consumed_ms IS NULL AND attempts < $2 RETURNING attempts",
      digest, maxAttempts);
  txn.commit();
  if (rows.empty()) return 0;  // spent or guessed out by a concurrent verify — dead either way
  return rows[0][0].as<int>();
}

bool PgAuthRepository::consumeLink(const std::string& digest, UnixMs at) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result result = txn.exec_params(
      "UPDATE magic_links SET consumed_ms = $2 WHERE token_hash = $1 AND consumed_ms IS NULL",
      digest, static_cast<long long>(at));
  txn.commit();
  return result.affected_rows() == 1;  // only the winner of a concurrent race flips the row
}

void PgAuthRepository::insertSession(const std::string& digest, const UserId& user, UnixMs expiresAt,
                                    const std::string& userAgent, const std::string& ip, UnixMs seenAt) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params(
      "INSERT INTO sessions (token_hash, user_id, expires_ms, user_agent, ip, last_seen_ms) "
      "VALUES ($1, $2::uuid, $3, $4, $5, $6)",
      digest, user.str(), static_cast<long long>(expiresAt), userAgent, ip,
      static_cast<long long>(seenAt));
  txn.commit();
}

std::optional<StoredSession> PgAuthRepository::findSession(const std::string& digest) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT user_id::text, expires_ms FROM sessions WHERE token_hash = $1", digest);
  if (rows.empty()) return std::nullopt;

  const auto& row = rows[0];
  return StoredSession{UserId{row["user_id"].as<std::string>()},
                       static_cast<UnixMs>(row["expires_ms"].as<long long>())};
}

bool PgAuthRepository::refreshSession(const std::string& digest, UnixMs expiresAt, UnixMs seenAt,
                                     const std::string& userAgent, const std::string& ip) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  const pqxx::result updated = txn.exec_params(
      "UPDATE sessions SET expires_ms = $2, last_seen_ms = $3, "
      "user_agent = coalesce(nullif($4, ''), user_agent), ip = coalesce(nullif($5, ''), ip) "
      "WHERE token_hash = $1",
      digest, static_cast<long long>(expiresAt), static_cast<long long>(seenAt), userAgent, ip);
  txn.commit();
  return updated.affected_rows() != 0;
}

void PgAuthRepository::deleteSession(const std::string& digest) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params("DELETE FROM sessions WHERE token_hash = $1", digest);
  txn.commit();
}

std::vector<SessionRow> PgAuthRepository::listSessions(const UserId& userId) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT id::text, token_hash, user_agent, last_seen_ms, "
      "(extract(epoch from created_at) * 1000)::bigint AS created_ms, ip "
      "FROM sessions WHERE user_id = $1::uuid "
      "ORDER BY greatest(last_seen_ms, (extract(epoch from created_at) * 1000)::bigint) DESC",
      userId.str());

  std::vector<SessionRow> sessions;
  sessions.reserve(rows.size());
  for (const auto& row : rows)
    sessions.push_back(SessionRow{row["id"].as<std::string>(), row["token_hash"].as<std::string>(),
                                  row["user_agent"].as<std::string>(),
                                  static_cast<UnixMs>(row["last_seen_ms"].as<long long>()),
                                  static_cast<UnixMs>(row["created_ms"].as<long long>()),
                                  row["ip"].as<std::string>()});
  return sessions;
}

std::optional<std::string> PgAuthRepository::revokeSession(const UserId& userId,
                                                           const std::string& sessionId) {
  // Compare id::text (not $1::uuid) so a malformed path id matches nothing instead of raising.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "DELETE FROM sessions WHERE id::text = $1 AND user_id = $2::uuid RETURNING token_hash",
      sessionId, userId.str());
  txn.commit();
  if (rows.empty()) return std::nullopt;
  return rows[0]["token_hash"].as<std::string>();
}

std::vector<std::string> PgAuthRepository::revokeSessionsExcept(const UserId& userId, const std::string& keepDigest) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "DELETE FROM sessions WHERE user_id = $1::uuid AND token_hash <> $2 RETURNING token_hash", userId.str(), keepDigest);
  txn.commit();
  return digestsOf(rows);
}

std::vector<std::string> PgAuthRepository::revokeAllSessions(const UserId& userId) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params("DELETE FROM sessions WHERE user_id = $1::uuid RETURNING token_hash", userId.str());
  txn.commit();
  return digestsOf(rows);
}

}
