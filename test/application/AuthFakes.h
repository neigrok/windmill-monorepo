#pragma once

#include "ports/AuthRepository.h"
#include "ports/Clock.h"
#include "ports/EmailSender.h"
#include "ports/TokenGenerator.h"

#include <map>
#include <optional>
#include <stdexcept>
#include <string>
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
};

struct FakeEmail : EmailSender {
  struct Sent {
    Email to;
    std::string url;
  };
  std::vector<Sent> sent;
  bool failNext = false;

  void sendMagicLink(const Email& to, const std::string& url) override {
    if (failNext) {
      failNext = false;
      throw std::runtime_error("can't reach the mail provider");
    }
    sent.push_back({to, url});
  }
};

struct FakeAuthRepository : AuthRepository {
  struct LinkRow {
    Email email;
    UnixMs createdAt;
    UnixMs expiresAt;
    std::optional<UnixMs> consumedAt;
  };
  std::map<std::string, LinkRow> links;           // digest -> row
  std::map<std::string, StoredSession> sessions;  // digest -> session
  std::map<std::string, User> usersByEmail;       // email  -> user
  std::map<std::string, User> usersById;          // id     -> user
  int nextUserId = 0;

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
    User user{UserId{"u" + std::to_string(++nextUserId)}, email, name};
    usersByEmail[email.value] = user;
    usersById[user.id.str()] = user;
    return user;
  }

  void insertLink(const std::string& digest, const Email& email, UnixMs createdAt,
                  UnixMs expiresAt) override {
    links[digest] = LinkRow{email, createdAt, expiresAt, std::nullopt};
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
    return StoredLink{it->second.email, it->second.consumedAt.has_value(), it->second.expiresAt};
  }
  bool consumeLink(const std::string& digest, UnixMs at) override {
    auto it = links.find(digest);
    if (it == links.end() || it->second.consumedAt) return false;  // already spent, or unknown
    it->second.consumedAt = at;
    return true;
  }

  void insertSession(const std::string& digest, const UserId& user, UnixMs expiresAt) override {
    sessions[digest] = StoredSession{user, expiresAt};
  }
  std::optional<StoredSession> findSession(const std::string& digest) override {
    auto it = sessions.find(digest);
    if (it == sessions.end()) return std::nullopt;
    return it->second;
  }
  void refreshSession(const std::string& digest, UnixMs expiresAt) override {
    auto it = sessions.find(digest);
    if (it != sessions.end()) it->second.expiresAt = expiresAt;
  }
  void deleteSession(const std::string& digest) override { sessions.erase(digest); }
};

}
