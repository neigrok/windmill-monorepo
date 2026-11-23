#include "platform/ai_service/AiServiceClient.h"

#include "platform/adapters/json/JsonText.h"
#include "test/testing.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <trantor/utils/Logger.h>

#include <algorithm>
#include <atomic>
#include <fstream>
#include <memory>
#include <mutex>
#include <regex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using namespace wm;

namespace {

// The AI service on loopback. It answers each connection it accepts with the next reply the test scripted, written a
// few bytes at a time so lines arrive split, closes it, and keeps the request it read. A client that has not come
// within ten seconds is not waited for.
class PlayedService {
public:
  struct Request {
    std::string head;
    std::string body;
  };

  explicit PlayedService(std::vector<std::string> replies) : listener_(::socket(AF_INET, SOCK_STREAM, 0)) {
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    socklen_t size = sizeof(address);
    if (listener_ < 0 || ::bind(listener_, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) != 0 ||
        ::getsockname(listener_, reinterpret_cast<sockaddr*>(&address), &size) != 0 || ::listen(listener_, 4) != 0)
      throw std::runtime_error("played service could not listen");
    port_ = ntohs(address.sin_port);
    server_ = std::thread([this, replies = std::move(replies)] {
      for (const std::string& reply : replies) {
        pollfd waiting{listener_, POLLIN, 0};
        if (::poll(&waiting, 1, 10'000) != 1) return;
        const int peer = ::accept(listener_, nullptr, nullptr);
        if (peer < 0) return;
#ifdef SO_NOSIGPIPE
        const int on = 1;
        ::setsockopt(peer, SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof(on));
#endif
        Request request = read(peer);
        {
          std::lock_guard guard(lock_);
          requests_.push_back(std::move(request));
        }
        for (std::size_t at = 0; at < reply.size(); at += 7) {
          const std::string piece = reply.substr(at, 7);
#ifdef MSG_NOSIGNAL
          if (::send(peer, piece.data(), piece.size(), MSG_NOSIGNAL) != static_cast<ssize_t>(piece.size())) break;
#else
          if (::send(peer, piece.data(), piece.size(), 0) != static_cast<ssize_t>(piece.size())) break;
#endif
        }
        ::close(peer);
      }
    });
  }

  ~PlayedService() {
    if (server_.joinable()) server_.join();
    if (listener_ >= 0) ::close(listener_);
  }

  PlayedService(const PlayedService&) = delete;
  PlayedService& operator=(const PlayedService&) = delete;

  std::string url() const { return "http://127.0.0.1:" + std::to_string(port_); }

  std::vector<Request> requests() {
    std::lock_guard guard(lock_);
    return requests_;
  }

private:
  // Through the end of the body its Content-Length names.
  static Request read(int peer) {
    std::string bytes;
    char buffer[16 * 1024];
    for (;;) {
      const auto got = ::recv(peer, buffer, sizeof(buffer), 0);
      if (got <= 0) break;
      bytes.append(buffer, static_cast<std::size_t>(got));
      const auto headEnd = bytes.find("\r\n\r\n");
      if (headEnd == std::string::npos) continue;
      const auto length = bytes.find("Content-Length: ");
      const std::size_t body = length == std::string::npos ? 0 : std::stoull(bytes.substr(length + 16));
      if (bytes.size() >= headEnd + 4 + body) return {bytes.substr(0, headEnd), bytes.substr(headEnd + 4, body)};
    }
    return {bytes, ""};
  }

  int listener_;
  int port_ = 0;
  std::mutex lock_;
  std::vector<Request> requests_;
  std::thread server_;
};

Json::Value fixtures() {
  std::ifstream file(std::string(WM_API_CONTRACT_DIR) + "/ai/wire/fixtures.json");
  Json::Value value;
  file >> value;
  return value;
}

// One event as the door writes it, after a heartbeat.
std::string event(const Json::Value& event, int id) {
  return ": heartbeat\n\nid: " + std::to_string(id) + "\nevent: " + event["event"].asString() + "\ndata: " +
      dump(event["data"]) + "\n\n";
}

std::string stream(const std::string& events) {
  return "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store, no-transform\r\n"
         "Connection: close\r\n\r\n" + events;
}

std::string refusal(int status, const std::string& body) {
  return "HTTP/1.1 " + std::to_string(status) + " Refused\r\nContent-Type: application/json\r\nContent-Length: " +
      std::to_string(body.size()) + "\r\nConnection: close\r\n\r\n" + body;
}

// Every event the fixtures stream for a text call, `started` to the `ended` that closes it and the `failed` after it.
std::string everyTextEvent() {
  const Json::Value wire = fixtures();
  std::string events;
  int id = 0;
  for (const Json::Value& each : wire["textEvents"]) events += event(each, ++id);
  return events;
}

// A clock a second further on each time it is read, so every pass signed is a pass of its own.
struct SteppingClock : Clock {
  std::atomic<std::uint64_t> now{1'800'000'000'000};
  std::uint64_t nowMs() override { return now.fetch_add(1'000); }
};

struct StillClock : Clock {
  std::uint64_t now = 1'800'000'000'000;
  std::uint64_t nowMs() override { return now; }
};

// What the client tells Sentry, by operation and detail.
struct Reports : FailureReporter {
  std::vector<std::string> told;
  void report(const std::string&, const std::string& where, const std::string& detail) override {
    told.push_back(where + " " + detail);
  }
};

std::shared_ptr<const AiPasses> signer() {
  return std::make_shared<const AiPasses>("nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A", "test-rfc8032", "development",
                                          R"({"gym.coach":1})");
}

TextQuestion question() {
  TextQuestion asked;
  asked.label = "echoes";
  asked.operation = "echo.segment";
  asked.model = "medium";
  asked.effort = "low";
  asked.cache = false;
  asked.maxTokens = 16000;
  asked.system = "Group the pieces.";
  asked.user = "1. устал\n2. но держусь\n";
  asked.schema = parse(R"({"type":"object","properties":{"starts":{"type":"array","items":{"type":"integer"}}},)"
                       R"("required":["starts"],"additionalProperties":false})");
  return asked;
}

std::string line(const std::string& head, const std::string& name) {
  const auto at = head.find("\r\n" + name + ": ");
  if (at == std::string::npos) return "";
  const auto start = at + name.size() + 4;
  return head.substr(start, head.find("\r\n", start) - start);
}

// Whether every field `ours` writes is one `theirs` writes too, with the same JSON type, down to a schema, which is the
// caller's own.
bool fieldsTheDoorReads(const Json::Value& ours, const Json::Value& theirs) {
  if (ours.type() != theirs.type()) return false;
  if (ours.isArray()) {
    for (Json::ArrayIndex i = 0; i < ours.size(); ++i)
      if (i >= theirs.size() || !fieldsTheDoorReads(ours[i], theirs[i])) return false;
  }
  if (ours.isObject()) {
    for (const std::string& key : ours.getMemberNames()) {
      if (!theirs.isMember(key)) return false;
      if (key != "schema" && !fieldsTheDoorReads(ours[key], theirs[key])) return false;
    }
  }
  return true;
}

}

TEST(the_client_puts_the_question_as_the_door_reads_it_and_takes_the_answer_the_call_ended_with) {
  Reports reports;
  PlayedService service{{stream(everyTextEvent())}};
  StillClock clock;
  AiServiceClient client{service.url(), signer(), clock, reports};

  const TextAnswer answer = client.ask(UserId{"account-vector"}, question());

  CHECK_EQ(answer.code, std::string("completed"));
  CHECK_EQ(answer.text, std::string("Hello"));
  const auto requests = service.requests();
  REQUIRE_EQ(requests.size(), std::size_t{1});
  CHECK(std::regex_match(requests[0].head.substr(0, requests[0].head.find("\r\n")),
                         std::regex(R"(PUT /v1/calls/[A-Za-z0-9_-]{22}/text\?label=echoes HTTP/1\.1)")));
  CHECK_EQ(line(requests[0].head, "Authorization"), "Bearer " + signer()->serverPass(UserId{"account-vector"}, clock.now));
  CHECK_EQ(line(requests[0].head, "Content-Type"), std::string("application/json"));
  CHECK_EQ(requests[0].body,
           std::string(R"({"cache":false,"effort":"low","messages":[{"parts":[{"text":"1. \u0443\u0441\u0442\u0430\u043b\n)"
                       R"(2. \u043d\u043e \u0434\u0435\u0440\u0436\u0443\u0441\u044c\n"}],)"
                       R"("role":"user"}],"model":"medium","output":{"maxTokens":16000,"schema":{"additionalProperties":)"
                       R"(false,"properties":{"starts":{"items":{"type":"integer"},"type":"array"}},"required":["starts"],)"
                       R"("type":"object"}},"system":["Group the pieces."]})"));
  CHECK(fieldsTheDoorReads(parse(requests[0].body), fixtures()["textRequest"]));
}

TEST(every_end_the_door_gives_a_text_call_is_read_as_its_stop_or_its_code) {
  Reports reports;
  const Json::Value wire = fixtures();
  std::string read;
  for (const std::string& name : wire["textTerminals"].getMemberNames()) {
    PlayedService service{{stream(event(wire["textEvents"][0], 1) + event(wire["textTerminals"][name], 2))}};
    StillClock clock;
    const TextAnswer answer = AiServiceClient{service.url(), signer(), clock, reports}.ask(UserId{"account-vector"}, question());
    read += name + " " + answer.code + " " + answer.text + "\n";
  }
  for (const auto& [name, events] : std::vector<std::pair<std::string, std::string>>{
           {"ended_unparsed", "event: ended\ndata: {\"stop\":\n\n"},
           {"ended_unknown_stop", "event: ended\ndata: {\"stop\":\"wandered\",\"message\":null}\n\n"},
           {"completed_without_message", "event: ended\ndata: {\"stop\":\"completed\",\"message\":7}\n\n"},
           {"failed_without_code", "event: failed\ndata: {\"charged\":\"0\"}\n\n"},
           {"failed_with_a_sentence", "event: failed\ndata: {\"code\":\"Not A Code\"}\n\n"}}) {
    PlayedService service{{stream(events)}};
    StillClock clock;
    const TextAnswer answer = AiServiceClient{service.url(), signer(), clock, reports}.ask(UserId{"account-vector"}, question());
    read += name + " " + answer.code + " " + answer.text + "\n";
  }

  CHECK_EQ(read, std::string("completed completed Hello\n"
                             "declined declined \n"
                             "null_charged completed Hello\n"
                             "provider_failed provider_failed \n"
                             "provider_rejected provider_rejected \n"
                             "provider_unavailable provider_unavailable \n"
                             "tool_calls tool_calls \n"
                             "truncated truncated \n"
                             "ended_unparsed unreadable \n"
                             "ended_unknown_stop unreadable \n"
                             "completed_without_message unreadable \n"
                             "failed_without_code unreadable \n"
                             "failed_with_a_sentence unreadable \n"));
}

TEST(every_refusal_before_the_stream_is_read_by_its_code_whatever_its_status) {
  Reports reports;
  const Json::Value wire = fixtures();
  std::vector<std::pair<int, Json::Value>> refusals;
  for (const Json::Value& each : wire["refusals"]) refusals.emplace_back(each["status"].asInt(), each["body"]);
  for (const std::string& name : wire["prestreamRefusals"].getMemberNames())
    refusals.emplace_back(wire["prestreamRefusals"][name]["status"].asInt(), wire["prestreamRefusals"][name]["body"]);
  // The shared background budgets' refusal, played here wherever the fixtures do not carry it.
  if (std::none_of(refusals.begin(), refusals.end(), [](const auto& each) { return each.second["code"] == "background_exhausted"; }))
    refusals.emplace_back(429, parse(R"({"code":"background_exhausted","allowance":null})"));

  std::string read;
  std::string expected;
  for (const auto& [status, body] : refusals) {
    if (body["code"].asString() == "pass_expired") continue;
    PlayedService service{{refusal(status, dump(body))}};
    StillClock clock;
    const TextAnswer answer = AiServiceClient{service.url(), signer(), clock, reports}.ask(UserId{"account-vector"}, question());
    read += std::to_string(status) + " " + answer.code + " asked " + std::to_string(service.requests().size()) + "\n";
    expected += std::to_string(status) + " " + body["code"].asString() + " asked 1\n";
  }
  PlayedService unreadable{{refusal(502, "<html>bad gateway</html>")}};
  StillClock clock;
  read += "502 " + AiServiceClient{unreadable.url(), signer(), clock, reports}.ask(UserId{"account-vector"}, question()).code + "\n";
  expected += "502 unreadable\n";

  CHECK_EQ(read, expected);
  // Every refusal echoes-on-ai-service.md §5 sorts is one the fixtures, or this case, play.
  for (const char* code : {"invalid_request", "too_large", "conflict", "result_gone", "subject_exhausted",
                           "concurrency_exhausted", "rate_limited", "background_exhausted", "busy", "paused",
                           "accounting_unavailable", "provider_unavailable", "provider_rejected", "pass_missing",
                           "pass_signature", "pass_audience", "pass_malformed"})
    CHECK(read.find(std::string(" ") + code + " asked 1\n") != std::string::npos);
}

TEST(an_expired_pass_is_signed_again_and_the_call_asked_once_more) {
  Reports reports;
  const std::string expired = refusal(401, R"({"code":"pass_expired","allowance":null})");
  SteppingClock clock;
  PlayedService renewed{{expired, stream(everyTextEvent())}};
  AiServiceClient client{renewed.url(), signer(), clock, reports};

  const TextAnswer answer = client.ask(UserId{"account-vector"}, question());

  CHECK_EQ(answer.code, std::string("completed"));
  const auto asked = renewed.requests();
  REQUIRE_EQ(asked.size(), std::size_t{2});
  CHECK_EQ(line(asked[0].head, "Authorization"), "Bearer " + signer()->serverPass(UserId{"account-vector"}, 1'800'000'000'000));
  CHECK_EQ(line(asked[1].head, "Authorization"), "Bearer " + signer()->serverPass(UserId{"account-vector"}, 1'800'000'001'000));
  CHECK_EQ(asked[0].head.substr(0, asked[0].head.find("\r\n")), asked[1].head.substr(0, asked[1].head.find("\r\n")));
  CHECK_EQ(asked[0].body, asked[1].body);

  PlayedService stillExpired{{expired, expired}};
  AiServiceClient again{stillExpired.url(), signer(), clock, reports};
  CHECK_EQ(again.ask(UserId{"account-vector"}, question()).code, std::string("pass_expired"));
  CHECK_EQ(stillExpired.requests().size(), std::size_t{2});
}

TEST(a_stream_that_breaks_before_its_end_is_asked_once_more_under_the_same_call_and_body) {
  Reports reports;
  const Json::Value wire = fixtures();
  const std::string broken = stream(event(wire["textEvents"][0], 1) + event(wire["textEvents"][1], 2) + "event: ended\ndata: {\"st");
  StillClock clock;
  PlayedService recovered{{broken, stream(everyTextEvent())}};

  const TextAnswer answer = AiServiceClient{recovered.url(), signer(), clock, reports}.ask(UserId{"account-vector"}, question());

  CHECK_EQ(answer.code, std::string("completed"));
  CHECK_EQ(answer.text, std::string("Hello"));
  const auto asked = recovered.requests();
  REQUIRE_EQ(asked.size(), std::size_t{2});
  CHECK_EQ(asked[0].head, asked[1].head);
  CHECK_EQ(asked[0].body, asked[1].body);

  PlayedService brokenTwice{{broken, broken}};
  CHECK_EQ(AiServiceClient(brokenTwice.url(), signer(), clock, reports).ask(UserId{"account-vector"}, question()).code,
           std::string("unreachable"));
  CHECK_EQ(brokenTwice.requests().size(), std::size_t{2});
}

// Asked again, the service may no longer hold the call: it restarted, or the answer outlived its linger. The call ends
// with the service's word for that, and the next call is asked under a callId of its own.
TEST(a_call_the_service_no_longer_holds_when_asked_again_ends_with_its_word_and_the_next_call_is_new) {
  Reports reports;
  const Json::Value wire = fixtures();
  const std::string broken = stream(event(wire["textEvents"][0], 1) + "event: ended\ndata: {\"st");
  std::string ended;
  for (const auto& [status, code] : std::vector<std::pair<int, std::string>>{{410, "result_gone"}, {404, "call_unknown"}}) {
    StillClock clock;
    PlayedService service{{broken, refusal(status, R"({"code":")" + code + R"(","allowance":null})"), stream(everyTextEvent())}};
    AiServiceClient client{service.url(), signer(), clock, reports};

    const TextAnswer gone = client.ask(UserId{"account-vector"}, question());
    const TextAnswer next = client.ask(UserId{"account-vector"}, question());

    const auto asked = service.requests();
    REQUIRE_EQ(asked.size(), std::size_t{3});
    const auto target = [&](std::size_t i) { return asked[i].head.substr(0, asked[i].head.find("\r\n")); };
    ended += gone.code + " " + next.code + (target(0) == target(1) ? " same call" : " another call") +
        (target(1) == target(2) ? ", then the same call\n" : ", then another call\n");
  }

  CHECK_EQ(ended, std::string("result_gone completed same call, then another call\n"
                              "call_unknown completed same call, then another call\n"));
}

TEST(a_service_nobody_answers_for_is_unreachable) {
  Reports reports;
  int port = 0;
  {
    const int listener = ::socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    socklen_t size = sizeof(address);
    REQUIRE(::bind(listener, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) == 0);
    REQUIRE(::getsockname(listener, reinterpret_cast<sockaddr*>(&address), &size) == 0);
    port = ntohs(address.sin_port);
    ::close(listener);
  }
  StillClock clock;
  AiServiceClient client{"http://127.0.0.1:" + std::to_string(port), signer(), clock, reports};

  CHECK_EQ(client.ask(UserId{"account-vector"}, question()).code, std::string("unreachable"));
  CHECK(reports.told.empty());
}

// A call the service gave no answer to is a line. Calls it has given none to for a quarter of an hour, with none answered
// between, are reported as `ai_service.unreachable`: the service is down, or the address is wrong.
TEST(a_service_that_stays_unanswering_is_reported_and_a_blip_is_not) {
  Reports reports;
  const Json::Value wire = fixtures();
  const std::string broken = stream(event(wire["textEvents"][0], 1));
  StillClock clock;
  PlayedService service{{broken, broken, broken, broken, broken, broken, stream(everyTextEvent()), broken, broken}};
  AiServiceClient client{service.url(), signer(), clock, reports};
  const std::uint64_t first = clock.now;
  std::string seen;
  for (const std::uint64_t at : {first, first + AiServiceClient::kUnansweredReportMs - 1,
                                 first + AiServiceClient::kUnansweredReportMs,
                                 first + AiServiceClient::kUnansweredReportMs + 1,
                                 first + 2 * AiServiceClient::kUnansweredReportMs}) {
    clock.now = at;
    const std::string code = client.ask(UserId{"account-vector"}, question()).code;
    seen += code + " reported " + std::to_string(reports.told.size()) + "\n";
  }

  const std::string expected = "unreachable reported 0\n"
                               "unreachable reported 0\n"
                               "unreachable reported 1\n"
                               "completed reported 1\n"
                               "unreachable reported 1\n";
  if (seen != expected) testing::fail(("seen:\n" + seen + "requests: " + std::to_string(service.requests().size())).c_str(), __FILE__, __LINE__);
  CHECK(reports.told == std::vector<std::string>{"ai_service.unreachable unanswered_minutes=15"});
}

TEST(an_accounts_pass_is_kept_for_half_its_lifetime_and_no_longer) {
  Reports reports;
  StillClock clock;
  PlayedService service{{stream(everyTextEvent()), stream(everyTextEvent()), stream(everyTextEvent())}};
  AiServiceClient client{service.url(), signer(), clock, reports};
  const std::uint64_t first = clock.now;

  client.ask(UserId{"account-vector"}, question());
  clock.now = first + AiServiceClient::kPassKeptMs - 1;
  client.ask(UserId{"account-vector"}, question());
  clock.now = first + AiServiceClient::kPassKeptMs;
  client.ask(UserId{"account-vector"}, question());

  const auto asked = service.requests();
  REQUIRE_EQ(asked.size(), std::size_t{3});
  const std::string kept = "Bearer " + signer()->serverPass(UserId{"account-vector"}, static_cast<long long>(first));
  CHECK_EQ(line(asked[0].head, "Authorization"), kept);
  CHECK_EQ(line(asked[1].head, "Authorization"), kept);
  CHECK_EQ(line(asked[2].head, "Authorization"),
           "Bearer " + signer()->serverPass(UserId{"account-vector"}, static_cast<long long>(clock.now)));
  CHECK(AiServiceClient::kPassKeptMs < static_cast<std::uint64_t>(kAiPassLifetimeMs));
}

TEST(every_call_logs_one_line_of_bounded_words_and_nothing_it_carried) {
  Reports reports;
  struct Logged {
    std::mutex mutex;
    std::string text;
    trantor::Logger::LogLevel level = trantor::Logger::logLevel();
    Logged() {
      trantor::Logger::setLogLevel(trantor::Logger::kInfo);
      trantor::Logger::setOutputFunction(
          [this](const char* message, std::uint64_t length) {
            std::lock_guard lock(mutex);
            text.append(message, length);
          },
          [] {});
    }
    ~Logged() {
      trantor::Logger::setOutputFunction([](const char* message, std::uint64_t length) { fwrite(message, 1, length, stdout); },
                                         [] { fflush(stdout); });
      trantor::Logger::setLogLevel(level);
    }
  };
  StillClock clock;
  PlayedService service{{stream(everyTextEvent()), refusal(429, R"({"code":"background_exhausted","allowance":null})")}};
  AiServiceClient client{service.url(), signer(), clock, reports};
  std::string text;
  {
    Logged logged;
    client.ask(UserId{"account-vector"}, question());
    TextQuestion curate = question();
    curate.operation = "echo.curate";
    client.ask(UserId{"account-vector"}, curate);
    std::lock_guard lock(logged.mutex);
    text = logged.text;
  }

  std::vector<std::string> lines;
  const std::regex call("ai_text_call [^\\n]*duration_ms=[0-9]+");
  for (std::sregex_iterator each(text.begin(), text.end(), call), end; each != end; ++each)
    lines.push_back(std::regex_replace(each->str(), std::regex("duration_ms=[0-9]+"), "duration_ms=N"));
  CHECK(lines == std::vector<std::string>({
      "ai_text_call operation=echo.segment label=echoes code=completed asks=1 duration_ms=N",
      "ai_text_call operation=echo.curate label=echoes code=background_exhausted asks=1 duration_ms=N"}));
  const auto requests = service.requests();
  REQUIRE_EQ(requests.size(), std::size_t{2});
  const std::string callId = requests[0].head.substr(14, 22);
  for (const std::string& carried : {std::string("устал"), std::string("Group the pieces"), std::string("Hello"), callId,
                                     signer()->serverPass(UserId{"account-vector"}, clock.now), std::string("account-vector")})
    CHECK(text.find(carried) == std::string::npos);
}
