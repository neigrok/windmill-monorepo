#pragma once

#include "products/gym/coach/TurnService.h"
#include "platform/adapters/crypto/OpenSslTokenGenerator.h"
#include "platform/adapters/json/JsonText.h"
#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/Jcs.h"
#include "test/platform/Fakes.h"
#include "test/platform/FakeAiBudgetRepository.h"
#include "test/products/gym/onboarding/OnboardingFixture.h"
#include "test/testing.h"

#include <chrono>
#include <condition_variable>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

// The turn service over a scripted model and a recording stream: the harness every coach test
// file shares. The test thread plays the phone.
namespace wm::gym::coachtest {

using namespace wm::gym::coach;

// Hands out `replies` one per model call, streaming each reply's text first the way the vendor
// does. A null reply is a transport failure; `{"refused": code}` is a round the allowance refused.
// Every call waits for `start` so a test can attach its stream before the first byte flows.
struct ScriptedModel : CoachModel {
  Json::Value replies{Json::arrayValue};
  bool wired = true;
  std::mutex mutex;
  std::condition_variable wake;
  bool started = false;
  std::size_t index = 0;
  std::vector<Json::Value> requests;
  std::function<void(int)> beforeReply;  // runs inside the round, after the request was taken
  std::function<void(int)> afterCall;
  std::function<bool()> continueRun;     // what the service asked the stream to keep checking

  bool configured() const override { return wired; }

  void start() {
    std::lock_guard lock(mutex);
    started = true;
    wake.notify_all();
  }

  ModelCall open(const TurnPrincipal&, const std::string&, std::function<void(const std::string&)> text,
                 std::function<bool()> keepStreaming, std::function<void(const std::string&)> refused) override {
    continueRun = std::move(keepStreaming);
    return [this, text, refused](const Json::Value& request) -> std::optional<Json::Value> {
      Json::Value reply;
      int number = 0;
      {
        std::unique_lock lock(mutex);
        wake.wait(lock, [this] { return started; });
        requests.push_back(request);
        if (index < static_cast<std::size_t>(replies.size())) reply = replies[static_cast<Json::ArrayIndex>(index)];
        number = static_cast<int>(++index);
      }
      if (beforeReply) beforeReply(number);
      std::optional<Json::Value> out;
      if (reply.isObject() && reply.isMember("refused")) {
        refused(reply["refused"].asString());
      } else if (reply.isObject()) {
        std::string soFar;
        for (const Json::Value& block : reply["content"]) {
          if (block["type"].asString() != "text") continue;
          soFar += block["text"].asString();
          text(soFar);
        }
        out = reply;
      }
      if (afterCall) afterCall(number);
      return out;
    };
  }
};

// The server executor of a bound seat's shares: records every call and answers a link.
struct FakeServer : ToolHost {
  std::vector<std::pair<std::string, Json::Value>> calls;
  std::vector<ToolDeclaration> declareTools() const override { return {}; }
  ToolResult callTool(const std::string& name, const Json::Value& arguments, const ToolCaller&) override {
    calls.push_back({name, arguments});
    Json::Value link(Json::objectValue);
    link["url"] = "https://windmill.works/s/share_" + std::to_string(calls.size());
    return ToolResult::json(link);
  }
};

// Every frame the turn sent, in order, across every attach.
struct Recorder : TurnSink {
  std::mutex mutex;
  std::condition_variable wake;
  std::vector<Json::Value> events;
  bool closed = false;

  void send(const std::string& event, const Json::Value& data, bool terminal) override {
    std::lock_guard lock(mutex);
    Json::Value frame(Json::objectValue);
    frame["event"] = event;
    frame["data"] = data;
    events.push_back(frame);
    closed = closed || terminal;
    wake.notify_all();
  }

  // Blocks until `count` frames were recorded or the stream closed; false on the timeout.
  bool waitFor(std::size_t count, std::chrono::milliseconds patience = std::chrono::seconds(5)) {
    std::unique_lock lock(mutex);
    return wake.wait_for(lock, patience, [&] { return events.size() >= count || closed; });
  }

  std::vector<Json::Value> snapshot() {
    std::lock_guard lock(mutex);
    return events;
  }

  bool isClosed() {
    std::lock_guard lock(mutex);
    return closed;
  }
};

struct Harness {
  fake::FakeClock clock;
  OpenSslTokenGenerator tokens;
  fake::FakeAiBudgetRepository budgetRepository;
  AiBudgetLimits limits;
  std::shared_ptr<AiBudgetService> budgets =
      std::make_shared<AiBudgetService>(budgetRepository, [this] { return limits; }, [this] { return clock.now; });
  onboardingtest::Installations installationRepository;
  std::shared_ptr<AiInstallations> installations =
      std::make_shared<AiInstallations>(installationRepository, budgets, tokens, clock, std::string(64, 'k'));
  fake::FakeSubscriptionRepository subscriptions;
  fake::FakeAiUsageRepository usage;
  Entitlements entitlements{subscriptions, usage};
  FakeServer server;
  std::shared_ptr<ScriptedModel> model = std::make_shared<ScriptedModel>();
  std::shared_ptr<onboardingtest::Failures> failures = std::make_shared<onboardingtest::Failures>();
  std::shared_ptr<TurnService> service = std::make_shared<TurnService>(
      model, gymAbilityCatalog(), server, entitlements, installations, clock, 2000, failures, std::chrono::milliseconds(300));

  TurnPrincipal bound() {
    TurnPrincipal principal;
    principal.seat = Seat::bound;
    principal.account = User{UserId{"44444444-4444-4444-4444-444444444444"}, Email{"lifter@example.test"}, "Lifter", {}};
    return principal;
  }

  TurnPrincipal anon() {
    const AiInstallationIssue issued = installations->issue("127.0.0.1");
    TurnPrincipal principal;
    principal.seat = Seat::anon;
    principal.installation = issued.principal;
    principal.address = "127.0.0.1";
    return principal;
  }

  TurnPrincipal principalFor(const std::string& seat) { return seat == "anon" ? anon() : bound(); }
};

inline std::string digestOf(const Json::Value& body) { return sync::sha256(sync::jcs(body)).hex(); }

inline std::vector<TurnCallResult> resultsOf(const Json::Value& body) {
  const TurnResultsRead read = readTurnResults(body);
  if (!read.code.empty()) throw std::runtime_error("a scripted results body is out of shape: " + read.code);
  return read.results;
}

// The `done` frame carries the seat's allowance, which belongs to the environment and not the exchange.
inline Json::Value withoutAllowance(Json::Value frame) {
  if (frame["event"].asString() == "done") frame["data"].removeMember("allowance");
  return frame;
}

}
