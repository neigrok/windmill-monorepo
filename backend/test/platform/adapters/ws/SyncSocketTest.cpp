#include "platform/adapters/ws/SyncSocket.h"
#include "platform/application/WriteObservation.h"

#include "test/platform/Fakes.h"
#include "test/testing.h"

#include <stdexcept>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::fake;

namespace {

struct SessionStore : FakeAuthRepository {
  bool unreachable = false;
  std::optional<StoredSession> findSession(const std::string& digest) override {
    if (unreachable) throw std::runtime_error("PRIVATE SESSION DETAIL");
    return FakeAuthRepository::findSession(digest);
  }
};

struct Reports : FailureReporter {
  std::vector<std::string> writes;
  void report(const std::string&, const std::string&, const std::string&) override {}
  void reportWrite(const std::string& operation, const std::string& product, const std::string& door,
                   const std::string& outcome, const std::string&, const std::string&) override {
    writes.push_back(operation + " " + product + " " + door + " " + outcome);
  }
};

}

// The gate's worker step: a session that resolves serves its account, one that does not is 401, and one the store
// cannot read is 503 and one Issue under a static operation, its message kept out.
TEST(sync_live_upgrade_reports_a_credential_it_cannot_resolve_and_answers_503) {
  SessionStore accounts;
  FakeEmail email;
  FakeTokens tokens;
  FakeClock clock;
  clock.now = 1'792'281'600'000;
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, clock};
  FakeAccountFootprint footprint;
  FakeSessionRevocations revocations;
  AuthService auth{accounts, email, tokens, clock, oauth, footprint, revocations, "https://windmill.works"};
  const User account{UserId{"44444444-4444-4444-4444-444444444444"}, Email{"test@example.test"}, "Test", {}};
  accounts.usersById[account.id.str()] = account;
  accounts.insertSession("digest-valid", account.id, clock.now + 1'000'000, "", "", clock.now);
  auto reports = std::make_shared<Reports>();
  std::vector<WriteCompletion> lines;
  installWriteSink([&lines](const WriteCompletion& completion) { lines.push_back(completion); });
  installWriteReporter(reports);
  const Json::Value envelope = sync::SyncReply::envelope(clock.now, "ep-1");
  const auto sent = [](const std::string& digest) {
    return sync::SentCredentials({sync::SentCredential{sync::SentCredential::Kind::authorization, digest}});
  };

  const sync::UpgradeProof served = sync::proveUpgrade(auth, sent("digest-valid"), envelope);
  CHECK(served.principal == std::optional<UserId>{account.id});
  CHECK_FALSE(served.refusal);
  const sync::UpgradeProof refused = sync::proveUpgrade(auth, sent("digest-unknown"), envelope);
  REQUIRE(refused.refusal);
  CHECK_EQ(refused.refusal->status, 401);
  CHECK(reports->writes.empty());

  accounts.unreachable = true;
  const sync::UpgradeProof unresolved = sync::proveUpgrade(auth, sent("digest-valid"), envelope);
  REQUIRE(unresolved.refusal);
  CHECK_EQ(unresolved.refusal->status, 503);
  CHECK_EQ(unresolved.refusal->body["error"].asString(), std::string{"unavailable"});
  CHECK_FALSE(unresolved.principal);
  CHECK_EQ(reports->writes, (std::vector<std::string>{"sync.live.upgrade platform websocket failed"}));
  // A session that resolves may refresh it, which completes under its own operation.
  std::vector<WriteCompletion> upgrades;
  for (const WriteCompletion& line : lines) if (line.operation == "sync.live.upgrade") upgrades.push_back(line);
  REQUIRE_EQ(upgrades.size(), std::size_t{1});
  CHECK_EQ(upgrades[0].door, std::string{"websocket"});
  CHECK_EQ(upgrades[0].outcome, std::string{"failed"});
  CHECK(upgrades[0].severity == WriteSeverity::error);
  installWriteSink({});
  installWriteReporter({});
}
