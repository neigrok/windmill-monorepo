#include "products/journal/adapters/llm/OpenAiTranscriber.h"

#include "platform/adapters/json/JsonText.h"
#include "platform/adapters/llm/AiCallBudget.h"
#include "test/platform/FakeAiBudgetRepository.h"
#include "test/platform/Fakes.h"
#include "test/testing.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <future>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::fake;

namespace {

// The vendor on loopback for one request: it answers with `status` and `body`, or closes without a word when `status`
// is 0, and hands the test the bytes it was sent. An empty request is a vendor nobody called within `waitMs`.
class StubVendor {
public:
  StubVendor(int status, std::string body, int waitMs = 10'000) : listener_(::socket(AF_INET, SOCK_STREAM, 0)) {
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    socklen_t size = sizeof address;
    if (::bind(listener_, reinterpret_cast<const sockaddr*>(&address), sizeof address) != 0 ||
        ::getsockname(listener_, reinterpret_cast<sockaddr*>(&address), &size) != 0 || ::listen(listener_, 1) != 0)
      throw std::runtime_error("the stub vendor could not listen");
    port_ = ntohs(address.sin_port);
    served_ = std::async(std::launch::async, [fd = listener_, status, body = std::move(body), waitMs] {
      pollfd ready{fd, POLLIN, 0};
      if (::poll(&ready, 1, waitMs) != 1) return std::string{};
      const int peer = ::accept(fd, nullptr, nullptr);
      if (peer < 0) return std::string{};
      const timeval timeout{5, 0};
      ::setsockopt(peer, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout);
      std::string request;
      while (!whole(request)) {
        char buffer[4096];
        const auto count = ::recv(peer, buffer, sizeof buffer, 0);
        if (count <= 0) break;
        request.append(buffer, static_cast<std::size_t>(count));
      }
      if (status > 0) {
        const std::string response = "HTTP/1.1 " + std::to_string(status) + " Stub\r\nContent-Type: application/json\r\n"
            "Content-Length: " + std::to_string(body.size()) + "\r\nConnection: close\r\n\r\n" + body;
        ::send(peer, response.data(), response.size(), 0);
      }
      ::close(peer);
      return request;
    });
  }
  ~StubVendor() {
    if (served_.valid()) served_.wait();
    ::close(listener_);
  }
  StubVendor(const StubVendor&) = delete;
  StubVendor& operator=(const StubVendor&) = delete;

  std::string origin() const { return "http://127.0.0.1:" + std::to_string(port_); }
  std::string request() { return served_.get(); }

private:
  static bool whole(const std::string& request) {
    const std::size_t head = request.find("\r\n\r\n");
    if (head == std::string::npos) return false;
    std::string headers = request.substr(0, head);
    std::transform(headers.begin(), headers.end(), headers.begin(), [](unsigned char c) { return std::tolower(c); });
    const std::size_t length = headers.find("content-length:");
    if (length == std::string::npos) return true;
    return request.size() >= head + 4 + std::stoull(headers.substr(length + 15));
  }

  int listener_;
  int port_ = 0;
  std::future<std::string> served_;
};

// An origin nothing listens on: the port was free a moment ago, so a connection to it is refused.
std::string refusingOrigin() {
  const int probe = ::socket(AF_INET, SOCK_STREAM, 0);
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  socklen_t size = sizeof address;
  ::bind(probe, reinterpret_cast<const sockaddr*>(&address), sizeof address);
  ::getsockname(probe, reinterpret_cast<sockaddr*>(&address), &size);
  ::close(probe);
  return "http://127.0.0.1:" + std::to_string(ntohs(address.sin_port));
}

struct Failures : FailureReporter {
  std::vector<std::string> reports;
  void report(const std::string& kind, const std::string& where, const std::string& detail) override {
    reports.push_back(kind + ":" + where + ":" + detail);
  }
};

// The ledger rows the transcriber writes, from whichever thread its loop answers on.
struct Ledger : UsageSink {
  std::mutex mutex;
  std::vector<AiSpend> rows;
  void record(const AiSpend& spend) noexcept override {
    std::lock_guard lock(mutex);
    rows.push_back(spend);
  }
};

// The durable allowance mode over fakes. The owner holds a funded calendar-month grant, as Windmill One's owner does;
// `subscriber` holds Windmill One with no grant behind it.
struct Allowances {
  FakeAiBudgetRepository repository;
  AiBudgetLimits limits;
  std::shared_ptr<AiBudgetService> budgets = std::make_shared<AiBudgetService>(
      repository, [this] { return limits; }, [] { return 1'792'000'000'000LL; });
  FakeAuthRepository accounts;
  FakeSubscriptionRepository subscriptions;
  FakeAiUsageRepository usage;
  Entitlements entitlements{subscriptions, usage, "owner@example.com", {}, budgets};
  Failures failures;
  std::shared_ptr<AiCallBudget> calls = std::make_shared<AiCallBudget>(budgets, entitlements, accounts, failures);
  User owner = accounts.createUser(Email{"owner@example.com"}, "Owner");
  User subscriber = accounts.createUser(Email{"sam@example.com"}, "Sam");
  std::shared_ptr<Ledger> ledger = std::make_shared<Ledger>();

  Allowances() { subscriptions.subscribe(subscriber.id); }
};

// The answer lands on the transcriber's loop when the take reaches the vendor, and inline when it is refused first.
Transcription transcribeOnce(OpenAiTranscriber& transcriber, const UserId& user) {
  auto answered = std::make_shared<std::promise<Transcription>>();
  std::future<Transcription> answer = answered->get_future();
  transcriber.transcribe(user, "opus-bytes", "audio/webm;codecs=opus",
                         [answered](Transcription take) { answered->set_value(std::move(take)); });
  if (answer.wait_for(std::chrono::seconds(20)) != std::future_status::ready)
    throw std::runtime_error("the transcriber never answered");
  return answer.get();
}

}

TEST(openai_transcription_is_priced_from_the_models_limits_and_the_vendors_token_usage) {
  CHECK_EQ(transcriptionCeilingNanos("gpt-4o-transcribe"), std::optional<long long>{16'000 * 2'500 + 2'000 * 10'000});
  CHECK_FALSE(transcriptionCeilingNanos("gpt-transcribe"));
  CHECK_FALSE(transcriptionCeilingNanos("whisper-1"));

  const Json::Value billed = parse(R"({"type":"tokens","input_tokens":1000,"input_token_details":
      {"text_tokens":0,"audio_tokens":1000},"output_tokens":100,"total_tokens":1100})");
  CHECK_EQ(transcriptionActualNanos("gpt-4o-transcribe", billed), std::optional<long long>{3'500'000});
  CHECK_FALSE(transcriptionActualNanos("whisper-1", billed));
  for (const std::string unreadable : {
           R"(null)", R"({"type":"duration","seconds":9.5})", R"({"input_tokens":1000,"output_tokens":100})",
           R"({"type":"tokens","input_tokens":1000})", R"({"type":"tokens","input_tokens":-1,"output_tokens":100})",
           R"({"type":"tokens","input_tokens":"1000","output_tokens":100})",
           R"({"type":"tokens","input_tokens":1000001,"output_tokens":100})"})
    CHECK_FALSE(transcriptionActualNanos("gpt-4o-transcribe", parse(unreadable)));

  Allowances a;
  CHECK(OpenAiTranscriber("sk-fixture-only", "gpt-4o-transcribe", nullptr, nullptr, a.calls).configured());
  CHECK_FALSE(OpenAiTranscriber("sk-fixture-only", "whisper-1", nullptr, nullptr, a.calls).configured());
  CHECK(OpenAiTranscriber("sk-fixture-only", "whisper-1").configured());
  CHECK_FALSE(OpenAiTranscriber("", "gpt-4o-transcribe").configured());
}

TEST(openai_transcription_holds_the_models_ceiling_and_settles_the_tokens_the_vendor_billed) {
  Allowances a;
  StubVendor vendor{200, R"({"text":"rain all morning","usage":{"type":"tokens","input_tokens":312,)"
                         R"("input_token_details":{"text_tokens":0,"audio_tokens":312},"output_tokens":9,"total_tokens":321}})"};
  OpenAiTranscriber transcriber{"sk-fixture-only", "gpt-4o-transcribe", nullptr, a.ledger, a.calls, vendor.origin()};

  const Transcription take = transcribeOnce(transcriber, a.owner.id);

  CHECK_EQ(take.text, std::optional<std::string>{"rain all morning"});
  CHECK_EQ(take.refusal, std::string{});
  REQUIRE_EQ(a.repository.reservations.size(), 1u);
  const AiBudgetReservation& held = a.repository.reservations.begin()->second;
  CHECK(held.subject == (AiBudgetSubject{AiBudgetSubjectKind::Account, a.owner.id.str()}));
  CHECK(held.tier == AiBudgetTier::WindmillOne);
  CHECK_EQ(held.grantId, std::optional<std::string>{"owner-period"});
  CHECK_EQ(held.amountNanos, 60'000'000);
  CHECK(held.state == AiBudgetState::Settled);
  CHECK_EQ(held.actualNanos, std::optional<long long>{312 * 2'500 + 9 * 10'000});

  const std::string request = vendor.request();
  const std::size_t head = request.find("\r\n\r\n");
  REQUIRE(head != std::string::npos);
  CHECK_EQ(request.substr(0, request.find("\r\n")), std::string{"POST /v1/audio/transcriptions HTTP/1.1"});
  CHECK(request.find("authorization: Bearer sk-fixture-only\r\n") != std::string::npos);
  CHECK(request.find("content-type: multipart/form-data; boundary=----WindmillTalkBoundaryVoZ8kQ1pXsW7\r\n") !=
        std::string::npos);
  CHECK_EQ(request.substr(head + 4), std::string{
      "------WindmillTalkBoundaryVoZ8kQ1pXsW7\r\n"
      "Content-Disposition: form-data; name=\"model\"\r\n\r\ngpt-4o-transcribe\r\n"
      "------WindmillTalkBoundaryVoZ8kQ1pXsW7\r\n"
      "Content-Disposition: form-data; name=\"response_format\"\r\n\r\njson\r\n"
      "------WindmillTalkBoundaryVoZ8kQ1pXsW7\r\n"
      "Content-Disposition: form-data; name=\"file\"; filename=\"audio.webm\"\r\n"
      "Content-Type: audio/webm;codecs=opus\r\n\r\n"
      "opus-bytes\r\n"
      "------WindmillTalkBoundaryVoZ8kQ1pXsW7--\r\n"});

  REQUIRE_EQ(a.ledger->rows.size(), 1u);
  const AiSpend& row = a.ledger->rows[0];
  CHECK_EQ(row.user, std::optional<UserId>{a.owner.id});
  CHECK_EQ(row.product + " " + row.operation + " " + row.model + " " + row.outcome,
           std::string{"journal transcribe gpt-4o-transcribe ok"});
  CHECK_EQ(row.tokens.input, 312);
  CHECK_EQ(row.tokens.output, 9);
  CHECK(a.failures.reports.empty());
}

TEST(openai_transcription_a_take_the_allowance_cannot_hold_never_reaches_the_vendor) {
  struct Case {
    std::string name;
    std::string refusal;
  };
  for (const Case& scenario : std::vector<Case>{{"spent", "subject_exhausted"},
                                                {"smaller than the ceiling", "subject_exhausted"},
                                                {"busy", "concurrency_exhausted"},
                                                {"unfunded", "funding_required"}}) {
    Allowances a;
    if (scenario.name == "spent") a.repository.totals.subject.spentNanos = a.limits.paidPeriodNanos;
    if (scenario.name == "smaller than the ceiling")
      a.repository.totals.subject.spentNanos = a.limits.paidPeriodNanos - 60'000'000 + 1;
    if (scenario.name == "busy") a.repository.totals.concurrentCalls = a.limits.paidConcurrency;
    const User& speaker = scenario.name == "unfunded" ? a.subscriber : a.owner;
    StubVendor vendor{200, R"({"text":"never asked"})", 300};
    OpenAiTranscriber transcriber{"sk-fixture-only", "gpt-4o-transcribe", nullptr, a.ledger, a.calls, vendor.origin()};

    const Transcription take = transcribeOnce(transcriber, speaker.id);

    CHECK_FALSE(take.text);
    CHECK_EQ(take.refusal, scenario.refusal);
    CHECK_EQ(vendor.request(), std::string{});
    CHECK(a.repository.reservations.empty());
    CHECK(a.ledger->rows.empty());
    CHECK(a.failures.reports.empty());
  }
}

// What the vendor consumed decides the charge: an answered error or a request that never connected consumed nothing
// and settles at zero, freeing the slot; a reply that may have been billed but says nothing readable about it keeps
// the whole hold as uncertain.
TEST(openai_transcription_settles_an_unconsumed_take_at_zero_and_holds_an_ambiguous_one) {
  struct Case {
    std::string name;
    int status;
    std::string body;
    std::optional<std::string> text;
    AiBudgetState state;
    std::optional<long long> actual;
    std::string outcome;
  };
  for (const Case& scenario : std::vector<Case>{
           {"vendor error", 500, R"({"error":{"message":"private vendor detail"}})", std::nullopt, AiBudgetState::Settled, 0, "transport"},
           {"rate limited", 429, R"({"error":{"message":"slow down"}})", std::nullopt, AiBudgetState::Settled, 0, "rate_limited"},
           {"refused connection", -1, "", std::nullopt, AiBudgetState::Settled, 0, "transport"},
           {"no usage", 200, R"({"text":"rain"})", "rain", AiBudgetState::Uncertain, std::nullopt, "ok"},
           {"billed by duration", 200, R"({"text":"rain","usage":{"type":"duration","seconds":4.2}})", "rain",
            AiBudgetState::Uncertain, std::nullopt, "ok"},
           {"unreadable", 200, "not json", std::nullopt, AiBudgetState::Uncertain, std::nullopt, "schema_invalid"},
           {"closed unanswered", 0, "", std::nullopt, AiBudgetState::Uncertain, std::nullopt, "transport"}}) {
    Allowances a;
    std::optional<StubVendor> vendor;
    if (scenario.status >= 0) vendor.emplace(scenario.status, scenario.body);
    OpenAiTranscriber transcriber{"sk-fixture-only", "gpt-4o-transcribe", nullptr, a.ledger, a.calls,
                                  vendor ? vendor->origin() : refusingOrigin()};

    const Transcription take = transcribeOnce(transcriber, a.owner.id);

    CHECK_EQ(take.text, scenario.text);
    CHECK_EQ(take.refusal, std::string{});
    REQUIRE_EQ(a.repository.reservations.size(), 1u);
    const AiBudgetReservation& held = a.repository.reservations.begin()->second;
    CHECK(held.state == scenario.state);
    CHECK_EQ(held.actualNanos, scenario.actual);
    CHECK_EQ(held.amountNanos, 60'000'000);
    REQUIRE_EQ(a.ledger->rows.size(), 1u);
    CHECK_EQ(a.ledger->rows[0].outcome, scenario.outcome);
    CHECK(a.failures.reports.empty());
  }
}
