#include "platform/adapters/ws/SyncSocket.h"
#include "platform/application/WriteObservation.h"

#include "test/DrogonLoopback.h"
#include "test/platform/Fakes.h"
#include "test/testing.h"

#include <trantor/net/EventLoopThread.h>

#include <chrono>
#include <future>
#include <memory>
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

// The gate's worker step: a session that resolves serves its account, one that does not is 401 and one WARN line, and one
// the store cannot read is 503, names no caller, and is one Issue under a static operation, its message kept out.
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
  REQUIRE(served.caller);
  CHECK(served.caller->credential.servedAs() == std::optional<UserId>{account.id});
  CHECK_FALSE(served.refusal);
  const sync::UpgradeProof refused = sync::proveUpgrade(auth, sent("digest-unknown"), envelope);
  REQUIRE(refused.refusal);
  CHECK_EQ(refused.refusal->status, 401);
  REQUIRE(refused.caller);
  CHECK(refused.caller->lapsed);
  CHECK(reports->writes.empty());

  accounts.unreachable = true;
  const sync::UpgradeProof unresolved = sync::proveUpgrade(auth, sent("digest-valid"), envelope);
  REQUIRE(unresolved.refusal);
  CHECK_EQ(unresolved.refusal->status, 503);
  CHECK_EQ(unresolved.refusal->body["error"].asString(), std::string{"unavailable"});
  CHECK_FALSE(unresolved.caller);
  CHECK_EQ(reports->writes, (std::vector<std::string>{"sync.live.upgrade platform websocket failed"}));
  // The served upgrade writes no line of its own; a session that resolves refreshes, under its own operation.
  std::vector<WriteCompletion> upgrades;
  for (const WriteCompletion& line : lines) if (line.operation == "sync.live.upgrade") upgrades.push_back(line);
  REQUIRE_EQ(upgrades.size(), std::size_t{2});
  CHECK_EQ(upgrades[0].product + " " + upgrades[0].door + " " + upgrades[0].outcome, std::string{"platform websocket unauthenticated"});
  CHECK(upgrades[0].severity == WriteSeverity::warn);
  CHECK_EQ(upgrades[1].door, std::string{"websocket"});
  CHECK_EQ(upgrades[1].outcome, std::string{"failed"});
  CHECK(upgrades[1].severity == WriteSeverity::error);
  installWriteSink({});
  installWriteReporter({});
}

// The gate before /v1/sync/live upgrades, run on a loop of its own as Drogon runs it: each refusal is one WARN line under
// `sync.live.upgrade` and opens nothing, and every answer leaves its caller for the upgrade's access line.
TEST(sync_live_upgrade_gate_refuses_with_one_warn_line_and_leaves_its_caller_for_the_access_line) {
  FakeAuthRepository accounts;
  FakeEmail email;
  FakeTokens tokens;
  auto clock = std::make_shared<FakeClock>();
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, *clock};
  FakeAccountFootprint footprint;
  FakeSessionRevocations revocations;
  auto auth = std::make_shared<AuthService>(accounts, email, tokens, *clock, oauth, footprint, revocations, "https://windmill.works");
  const User ann = accounts.createUser(Email{"ann@example.com"}, "Ann");
  const User bob = accounts.createUser(Email{"bob@example.com"}, "Bob");
  accounts.insertSession(tokens.digestOf("s-ann"), ann.id, clock->now + 1'000'000, "", "", clock->now);
  accounts.insertSession(tokens.digestOf("s-bob"), bob.id, clock->now + 1'000'000, "", "", clock->now);
  const sync::SyncSocketDeps deps{.workers = std::make_shared<WorkerPool>("sync-gate-test", 1, 8), .auth = auth, .clock = clock,
                                  .allowedOrigins = {"https://windmill.works"}, .minSchema = 2, .epoch = "ep-1"};
  std::vector<WriteCompletion> lines;
  installWriteSink([&lines](const WriteCompletion& completion) { lines.push_back(completion); });
  trantor::EventLoopThread loop;
  loop.run();
  const auto admitted = [&](const std::string& target, const std::vector<std::string>& fields) {
    lines.clear();
    const drogon::HttpRequestPtr req = wm::test::DrogonLoopback::received("GET", target, fields);
    auto answered = std::make_shared<std::promise<std::string>>();
    std::future<std::string> answer = answered->get_future();
    loop.getLoop()->queueInLoop([&deps, req, answered] {
      sync::admitUpgrade(deps, req,
          [answered](const drogon::HttpResponsePtr& refusal) { answered->set_value(std::to_string(static_cast<int>(refusal->statusCode()))); },
          [answered] { answered->set_value("passed"); });
    });
    if (answer.wait_for(std::chrono::seconds(10)) != std::future_status::ready) throw std::runtime_error("the gate did not answer within 10 s");
    std::string out = answer.get();
    for (const WriteCompletion& line : lines)
      if (line.operation == "sync.live.upgrade")
        out += " " + line.door + " " + line.outcome + (line.severity == WriteSeverity::warn ? " WARN" : " not WARN");
    const std::string caller = req->attributes()->find(kCallerAttribute) ? req->attributes()->get<std::string>(kCallerAttribute) : "anon";
    return out + " as " + (caller == ann.id.str() ? "ann" : caller);
  };
  CHECK_EQ(admitted("/v1/sync/live?schema=2", {"Host: sync", "Cookie: wm_session=s-ann"}), std::string("passed as ann"));
  CHECK_EQ(admitted("/v1/sync/live?schema=2", {"Host: sync", "authorization: bearer s-ann"}), std::string("passed as ann"));
  CHECK_EQ(admitted("/v1/sync/live?schema=2", {"Host: sync"}), std::string("passed as anon"));
  CHECK_EQ(admitted("/v1/sync/live?schema=2", {"Host: sync", "Origin: https://evil.example", "Cookie: wm_session=s-ann"}),
           std::string("403 websocket untrusted-origin WARN as anon"));
  CHECK_EQ(admitted("/v1/sync/live", {"Host: sync", "Cookie: wm_session=s-ann"}), std::string("400 websocket malformed WARN as anon"));
  CHECK_EQ(admitted("/v1/sync/live?schema=1", {"Host: sync", "Cookie: wm_session=s-ann"}),
           std::string("426 websocket upgrade-required WARN as anon"));
  CHECK_EQ(admitted("/v1/sync/live?schema=2", {"Host: sync", "Cookie: wm_session=s-ann", "Authorization: Bearer s-bob"}),
           std::string("401 websocket unauthenticated WARN as refused"));
  CHECK_EQ(admitted("/v1/sync/live?schema=2", {"Host: sync", "Cookie: wm_session=s-gone"}),
           std::string("401 websocket unauthenticated WARN as lapsed"));
  installWriteSink({});
}
