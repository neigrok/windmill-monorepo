#pragma once

#include "platform/ports/AuthRepository.h"
#include "platform/ports/Clock.h"
#include "platform/ports/EmailSender.h"
#include "platform/ports/McpKeyRepository.h"
#include "platform/ports/OAuthRepository.h"
#include "platform/ports/TokenGenerator.h"

#include <algorithm>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace wm::fake {

// A clock the test drives by hand. Starts at a fixed, comfortably-past-epoch instant so
// the 90-day window arithmetic never underflows.
struct FakeClock : Clock {
  UnixMs now = 1'700'000'000'000;
  std::uint64_t nowMs() override { return now; }
};

// Deterministic tokens: the n-th mint is secret "s{n}" with digest "d{n}", and digestOf
// maps any "s{n}" back to "d{n}" — so a test can present a minted secret and have it
// resolve to the same stored digest.
struct FakeTokens : TokenGenerator {
  int counter = 0;
  MintedToken mint() override {
    ++counter;
    return {"s" + std::to_string(counter), "d" + std::to_string(counter)};
  }
  std::string digestOf(const std::string& secret) override {
    return secret.empty() ? "" : "d" + secret.substr(1);
  }
  std::string s256Challenge(const std::string& verifier) override {
    return "c:" + verifier;  // deterministic, invertible for the PKCE assertions
  }
};

struct FakeEmail : EmailSender {
  struct Sent {
    Email to;
    std::string url;
    std::string templateId;
    std::string treeTitle;
    std::string treeMeta;
    ReminderMail reminder;  // only meaningful for the 'reminder' template
    JournalNudgeMail journalNudge;  // only meaningful for the 'journal-nudge' template
  };
  std::vector<Sent> sent;
  bool failNext = false;

  void sendMagicLink(const Email& to, const std::string& url,
                     std::function<void(bool)> done) override {
    deliver({to, url, "magic-link", "", "", {}}, std::move(done));
  }
  void sendForkLink(const Email& to, const std::string& url, const std::string& treeTitle,
                    const std::string& treeMeta, std::function<void(bool)> done) override {
    deliver({to, url, "magic-link-fork", treeTitle, treeMeta, {}}, std::move(done));
  }
  // The weekly reminder arrives fully rendered, so the fake keeps the whole mail: the sweep's
  // tests read the deep link, the pause link and the step slots straight back off it.
  void sendReminder(const Email& to, const ReminderMail& mail,
                    std::function<void(bool)> done) override {
    deliver({to, mail.treeUrl, "reminder", mail.treeName, "", mail}, std::move(done));
  }
  // The daily journal nudge, fully rendered: the fake keeps the whole mail so the sweep's tests
  // read the pause and settings links straight back off it.
  void sendJournalNudge(const Email& to, const JournalNudgeMail& mail,
                        std::function<void(bool)> done) override {
    deliver({to, mail.settingsUrl, "journal-nudge", "", "", {}, mail}, std::move(done));
  }
  // Async like the real sender, but resolves inline: a failed send records nothing and
  // reports false (the caller inserted the link row already, so it survives the failure),
  // a good one records the mail and reports true.
  void deliver(Sent mail, std::function<void(bool)> done) {
    if (failNext) {
      failNext = false;
      done(false);
      return;
    }
    sent.push_back(std::move(mail));
    done(true);
  }
};

struct FakeAuthRepository : AuthRepository {
  struct LinkRow {
    Email email;
    UnixMs createdAt;
    UnixMs expiresAt;
    std::optional<UnixMs> consumedAt;
    std::string forkSource;
  };
  // A session row as the real table carries it: keyed by its digest, with the public id, the
  // device metadata, and the recency stamps the §5 list reads.
  struct SessionRecord {
    std::string id;
    UserId user;
    UnixMs expiresAt = 0;
    std::string userAgent;
    UnixMs lastSeenMs = 0;
    UnixMs createdAtMs = 0;
    std::string ip;
  };
  std::map<std::string, LinkRow> links;             // digest -> row
  std::map<std::string, SessionRecord> sessions;    // digest -> record
  std::map<std::string, User> usersByEmail;         // email  -> user
  std::map<std::string, User> usersById;            // id     -> user
  int nextUserId = 0;
  int nextSessionId = 0;

  std::optional<User> findUserByEmail(const Email& email) override {
    auto it = usersByEmail.find(email.value);
    if (it == usersByEmail.end()) return std::nullopt;
    return it->second;
  }
  std::optional<User> findUserById(const UserId& id) override {
    auto it = usersById.find(id.str());
    if (it == usersById.end()) return std::nullopt;
    return it->second;
  }
  User createUser(const Email& email, const std::string& name) override {
    User user{UserId{"u" + std::to_string(++nextUserId)}, email, name, std::nullopt};
    usersByEmail[email.value] = user;
    usersById[user.id.str()] = user;
    return user;
  }
  void updateName(const UserId& userId, const std::string& name) override {
    auto it = usersById.find(userId.str());
    if (it == usersById.end()) return;
    it->second.name = name;
    usersByEmail[it->second.email.value].name = name;
  }
  void markUserDeleted(const UserId& userId, UnixMs now) override { setDeleted(userId, now); }
  void reviveUser(const UserId& userId) override { setDeleted(userId, std::nullopt); }

  void insertLink(const std::string& digest, const Email& email, UnixMs createdAt,
                  UnixMs expiresAt, const std::string& forkSource) override {
    links[digest] = LinkRow{email, createdAt, expiresAt, std::nullopt, forkSource};
  }
  int countRecentLinks(const Email& email, UnixMs since) override {
    int count = 0;
    for (const auto& [digest, row] : links) {
      if (row.email == email && !row.consumedAt && row.createdAt >= since) ++count;
    }
    return count;
  }
  std::optional<StoredLink> findLink(const std::string& digest) override {
    auto it = links.find(digest);
    if (it == links.end()) return std::nullopt;
    return StoredLink{it->second.email, it->second.consumedAt.has_value(), it->second.expiresAt,
                      it->second.forkSource};
  }
  bool consumeLink(const std::string& digest, UnixMs at) override {
    auto it = links.find(digest);
    if (it == links.end() || it->second.consumedAt) return false;  // already spent, or unknown
    it->second.consumedAt = at;
    return true;
  }

  void insertSession(const std::string& digest, const UserId& user, UnixMs expiresAt,
                     const std::string& userAgent, const std::string& ip, UnixMs seenAt) override {
    sessions[digest] = SessionRecord{"sess" + std::to_string(++nextSessionId), user, expiresAt,
                                     userAgent, seenAt, seenAt, ip};
  }
  std::optional<StoredSession> findSession(const std::string& digest) override {
    auto it = sessions.find(digest);
    if (it == sessions.end()) return std::nullopt;
    return StoredSession{it->second.user, it->second.expiresAt};
  }
  void refreshSession(const std::string& digest, UnixMs expiresAt, UnixMs seenAt,
                      const std::string& userAgent, const std::string& ip) override {
    auto it = sessions.find(digest);
    if (it == sessions.end()) return;
    it->second.expiresAt = expiresAt;
    it->second.lastSeenMs = seenAt;
    if (!userAgent.empty()) it->second.userAgent = userAgent;  // heal only when the request carries it
    if (!ip.empty()) it->second.ip = ip;
  }
  void deleteSession(const std::string& digest) override { sessions.erase(digest); }

  std::vector<SessionRow> listSessions(const UserId& userId) override {
    std::vector<SessionRow> out;
    for (const auto& [digest, record] : sessions) {
      if (!(record.user == userId)) continue;
      out.push_back(SessionRow{record.id, digest, record.userAgent, record.lastSeenMs,
                               record.createdAtMs, record.ip});
    }
    return out;
  }
  std::optional<std::string> revokeSession(const UserId& userId, const std::string& sessionId) override {
    for (auto it = sessions.begin(); it != sessions.end(); ++it) {
      if (it->second.id == sessionId && it->second.user == userId) {
        std::string digest = it->first;
        sessions.erase(it);
        return digest;
      }
    }
    return std::nullopt;
  }
  void revokeSessionsExcept(const UserId& userId, const std::string& keepDigest) override {
    for (auto it = sessions.begin(); it != sessions.end();) {
      if (it->second.user == userId && it->first != keepDigest) it = sessions.erase(it);
      else ++it;
    }
  }
  void revokeAllSessions(const UserId& userId) override {
    for (auto it = sessions.begin(); it != sessions.end();) {
      if (it->second.user == userId) it = sessions.erase(it);
      else ++it;
    }
  }

  void setDeleted(const UserId& userId, std::optional<UnixMs> at) {
    auto it = usersById.find(userId.str());
    if (it == usersById.end()) return;
    it->second.deletedAt = at;
    usersByEmail[it->second.email.value].deletedAt = at;
  }
};

// Personal MCP API keys as a fake: the digest→row map the real table keys on, plus the public
// id. findActiveUser models just the digest→user + expiry gate (the real deleted_at JOIN is
// SQL-only); touchUsed and revoke mirror the throttled last-used write and the owner-scoped delete.
struct FakeMcpKeyRepository : McpKeyRepository {
  struct KeyRow {
    std::string id;
    UserId user;
    std::string name;
    long long createdMs = 0;
    std::optional<long long> lastUsedMs;
    std::optional<long long> expiresMs;
  };
  std::map<std::string, KeyRow> keys;  // digest -> row
  int nextKeyId = 0;

  std::string insert(const std::string& tokenDigest, const UserId& user, const std::string& name,
                     long long createdMs) override {
    std::string id = "key" + std::to_string(++nextKeyId);
    keys[tokenDigest] = KeyRow{id, user, name, createdMs, std::nullopt, std::nullopt};
    return id;
  }
  std::vector<McpKeyRow> list(const UserId& user) override {
    std::vector<McpKeyRow> out;
    for (const auto& [digest, row] : keys)
      if (row.user == user) out.push_back(McpKeyRow{row.id, row.name, row.createdMs, row.lastUsedMs});
    std::sort(out.begin(), out.end(),
              [](const McpKeyRow& a, const McpKeyRow& b) { return a.createdMs > b.createdMs; });
    return out;
  }
  bool revoke(const UserId& user, const std::string& id) override {
    for (auto it = keys.begin(); it != keys.end(); ++it) {
      if (it->second.id == id && it->second.user == user) {
        keys.erase(it);
        return true;
      }
    }
    return false;
  }
  std::optional<UserId> findActiveUser(const std::string& tokenDigest, long long nowMs) override {
    auto it = keys.find(tokenDigest);
    if (it == keys.end()) return std::nullopt;
    if (it->second.expiresMs && *it->second.expiresMs <= nowMs) return std::nullopt;
    return it->second.user;
  }
  void touchUsed(const std::string& tokenDigest, long long nowMs, long long throttleMs) override {
    auto it = keys.find(tokenDigest);
    if (it == keys.end()) return;
    if (!it->second.lastUsedMs || *it->second.lastUsedMs < nowMs - throttleMs)
      it->second.lastUsedMs = nowMs;
  }
};

// The OAuth repository as a fake, shared by the OAuth service tests and the account-close
// tests. Grants live apart from the rotation-prone token rows, exactly as the real table does.
struct FakeOAuthRepository : OAuthRepository {
  std::map<std::string, OAuthClient> clients;
  std::map<std::string, StoredCode> codes;
  std::map<std::string, StoredToken> access;
  struct Refresh { StoredToken grant; UnixMs expiresAt; };
  std::map<std::string, Refresh> refresh;
  struct GrantRow { UnixMs grantedMs = 0; UnixMs lastUsedMs = 0; };
  std::map<std::pair<std::string, std::string>, GrantRow> grants;  // (userId, clientId) -> row

  void registerClient(const OAuthClient& client) override { clients[client.clientId] = client; }
  std::optional<OAuthClient> findClient(const std::string& id) override {
    auto it = clients.find(id);
    if (it == clients.end()) return std::nullopt;
    return it->second;
  }
  void insertCode(const std::string& digest, const StoredCode& code) override { codes[digest] = code; }
  std::optional<StoredCode> takeCode(const std::string& digest) override {
    auto it = codes.find(digest);
    if (it == codes.end()) return std::nullopt;
    StoredCode code = it->second;
    codes.erase(it);
    return code;
  }
  void insertToken(const std::string& accessDigest, const std::string& refreshDigest,
                   const StoredToken& token, UnixMs refreshExpiresAt) override {
    access[accessDigest] = token;
    refresh[refreshDigest] = Refresh{token, refreshExpiresAt};
  }
  std::optional<StoredToken> findAccessToken(const std::string& digest) override {
    auto it = access.find(digest);
    if (it == access.end()) return std::nullopt;
    return it->second;
  }
  std::optional<StoredToken> takeRefreshToken(const std::string& digest, UnixMs now) override {
    auto it = refresh.find(digest);
    if (it == refresh.end() || it->second.expiresAt <= now) return std::nullopt;
    StoredToken grant = it->second.grant;
    refresh.erase(it);
    return grant;
  }

  void recordGrant(const UserId& user, const std::string& clientId, UnixMs now) override {
    auto key = std::make_pair(user.str(), clientId);
    auto it = grants.find(key);
    if (it == grants.end()) {
      grants[key] = GrantRow{now, now};
      return;
    }
    it->second.grantedMs = std::min(it->second.grantedMs, now);  // set once, kept as the earliest
    it->second.lastUsedMs = now;
  }
  void touchGrantUsed(const UserId& user, const std::string& clientId, UnixMs now,
                      UnixMs minIntervalMs) override {
    auto it = grants.find({user.str(), clientId});
    if (it != grants.end() && now - it->second.lastUsedMs > minIntervalMs) it->second.lastUsedMs = now;
  }
  std::vector<GrantView> listGrants(const UserId& user) override {
    std::vector<GrantView> out;
    for (const auto& [key, row] : grants) {
      if (key.first != user.str()) continue;
      std::string name;
      auto c = clients.find(key.second);
      if (c != clients.end()) name = c->second.name;
      out.push_back(GrantView{key.second, name, row.grantedMs, row.lastUsedMs});
    }
    return out;
  }
  void revokeGrant(const UserId& user, const std::string& clientId) override {
    grants.erase({user.str(), clientId});
    eraseTokens([&](const StoredToken& t) { return t.user == user && t.clientId == clientId; });
    eraseCodes([&](const StoredCode& c) { return c.user == user && c.clientId == clientId; });
  }
  void revokeAllGrants(const UserId& user) override {
    for (auto it = grants.begin(); it != grants.end();) {
      if (it->first.first == user.str()) it = grants.erase(it);
      else ++it;
    }
    eraseTokens([&](const StoredToken& t) { return t.user == user; });
    eraseCodes([&](const StoredCode& c) { return c.user == user; });
  }

  template <typename Pred>
  void eraseTokens(Pred match) {
    for (auto it = access.begin(); it != access.end();) {
      if (match(it->second)) it = access.erase(it);
      else ++it;
    }
    for (auto it = refresh.begin(); it != refresh.end();) {
      if (match(it->second.grant)) it = refresh.erase(it);
      else ++it;
    }
  }
  template <typename Pred>
  void eraseCodes(Pred match) {
    for (auto it = codes.begin(); it != codes.end();) {
      if (match(it->second)) it = codes.erase(it);
      else ++it;
    }
  }
};

}
