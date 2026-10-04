#include "platform/adapters/http/WriteRoutes.h"
#include "platform/adapters/http/JsonReply.h"
#include "platform/adapters/clock/SystemClock.h"
#include "products/gym/routes.h"
#include "products/journal/routes.h"
#include "test/testing.h"

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <optional>
#include <regex>
#include <set>
#include <stdexcept>
#include <typeinfo>
#include <vector>

using namespace wm;

namespace {
struct HttpWriteCapture : FailureReporter {
  std::vector<WriteCompletion> lines;
  std::vector<std::string> issues;

  HttpWriteCapture() {
    installWriteSink([this](const WriteCompletion& completion) { lines.push_back(completion); });
  }
  ~HttpWriteCapture() {
    installWriteSink({});
    installWriteReporter({});
  }
  void report(const std::string& kind, const std::string& operation, const std::string& detail) override {
    issues.push_back(kind + " " + operation + " " + detail);
  }
};

std::string sourceText(const std::filesystem::path& path) {
  std::ifstream input(path);
  return std::string(std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>());
}

struct LegacyRestRetirement {
  std::optional<std::string> previous;
  explicit LegacyRestRetirement(const char* value) {
    if (const char* current = std::getenv("LEGACY_REST_WRITES_RETIRED")) previous = current;
    if (value) setenv("LEGACY_REST_WRITES_RETIRED", value, 1);
    else unsetenv("LEGACY_REST_WRITES_RETIRED");
  }
  ~LegacyRestRetirement() {
    if (previous) setenv("LEGACY_REST_WRITES_RETIRED", previous->c_str(), 1);
    else unsetenv("LEGACY_REST_WRITES_RETIRED");
  }
};

std::filesystem::path backendPath() {
  auto backend = std::filesystem::path(__FILE__);
  for (int parent = 0; parent < 5; ++parent) backend = backend.parent_path();
  return backend;
}
}

TEST(write_http_mutating_methods_have_static_operation_names) {
  CHECK(mutatingMethod(drogon::Post));
  CHECK(mutatingMethod(drogon::Put));
  CHECK(mutatingMethod(drogon::Patch));
  CHECK(mutatingMethod(drogon::Delete));
  CHECK_FALSE(mutatingMethod(drogon::Get));
  CHECK_FALSE(mutatingMethod(drogon::Options));
  CHECK_EQ(routeOperation("gym", "/v1/gym/sessions/{id}/sets", {drogon::Post}),
           std::string("gym.POST.v1.gym.sessions.id.sets"));
}

TEST(write_http_callback_preserves_the_response_and_completes_only_once) {
  HttpWriteCapture capture;
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setPath("/v1/test/write/private-input");
  request->setMethod(drogon::Post);
  WriteHttpCallback pending;
  const auto original = error(drogon::k409Conflict, "PRIVATE JOURNAL TEXT", "session-id-taken");
  original->addHeader("X-Fixture", "response header");
  auto handler = [&pending](const drogon::HttpRequestPtr&, WriteHttpCallback&& callback,
                            const std::string&) { pending = std::move(callback); };
  const WriteRoute route{"/v1/test/write/{id}", "test.write", "gym", "rest", {drogon::Post}};
  auto wrapped = detail::ObservedHttpHandler<decltype(&decltype(handler)::operator())>::wrap(route, handler);
  std::vector<drogon::HttpResponsePtr> responses;
  wrapped(request, [&responses](const drogon::HttpResponsePtr& response) { responses.push_back(response); }, "PRIVATE ID");
  CHECK(capture.lines.empty());
  pending(original);
  pending(original);
  REQUIRE_EQ(capture.lines.size(), std::size_t{1});
  CHECK_EQ(capture.lines[0].operation, std::string("test.write"));
  CHECK_EQ(capture.lines[0].product, std::string("gym"));
  CHECK_EQ(capture.lines[0].door, std::string("rest"));
  CHECK_EQ(capture.lines[0].outcome, std::string("session-id-taken"));
  CHECK_FALSE(capture.lines[0].requestId.empty());
  CHECK(capture.lines[0].durationMs >= 0);
  CHECK_EQ(responses, (std::vector<drogon::HttpResponsePtr>{original, original}));
  CHECK_EQ(original->getHeader("X-Fixture"), std::string("response header"));
  CHECK(capture.issues.empty());
}

TEST(write_http_retirement_is_off_by_default_and_accepts_only_one) {
  HttpWriteCapture capture;
  const auto original = error(drogon::k409Conflict, "original response", "session-id-taken");
  int calls = 0;
  auto handler = [&](const drogon::HttpRequestPtr&, WriteHttpCallback&& callback) {
    ++calls;
    callback(original);
  };
  const WriteRoute route{"/v1/test/legacy", "test.legacy", "gym", "rest", {drogon::Post}, true};
  auto wrapped = detail::ObservedHttpHandler<decltype(&decltype(handler)::operator())>::wrap(route, handler);
  const std::vector<const char*> disabled{nullptr, "", "0", "true", "on", "01", "1 "};
  for (const char* value : disabled) {
    LegacyRestRetirement retirement(value);
    auto request = drogon::HttpRequest::newHttpRequest();
    request->setMethod(drogon::Post);
    drogon::HttpResponsePtr response;
    wrapped(request, [&response](const drogon::HttpResponsePtr& reply) { response = reply; });
    CHECK_EQ(response, original);
    CHECK_FALSE(legacyRestWriteRetired(request));
  }
  CHECK_EQ(calls, static_cast<int>(disabled.size()));
  REQUIRE_EQ(capture.lines.size(), disabled.size());
  for (const auto& line : capture.lines) CHECK_EQ(line.outcome, std::string("session-id-taken"));
  CHECK(capture.issues.empty());
}

TEST(write_http_retirement_refuses_before_auth_body_parsing_or_handler_work) {
  LegacyRestRetirement retirement("1");
  HttpWriteCapture capture;
  installWriteReporter(std::shared_ptr<FailureReporter>(&capture, [](FailureReporter*) {}));
  int calls = 0;
  auto handler = [&calls](const drogon::HttpRequestPtr&, WriteHttpCallback&&, const std::string&) {
    ++calls;
    throw std::runtime_error("handler must not run");
  };
  Json::Value expected(Json::objectValue);
  expected["error"] = "This version of the app can no longer save; update it.";
  expected["code"] = "client-update-required";
  for (const auto method : {drogon::Post, drogon::Put, drogon::Patch, drogon::Delete}) {
    const WriteRoute route{"/v1/test/legacy/{id}", "test.legacy", "journal", "rest", {method}, true};
    auto wrapped = detail::ObservedHttpHandler<decltype(&decltype(handler)::operator())>::wrap(route, handler);
    for (const char* authorization : {"", "Bearer PRIVATE TOKEN"}) {
      auto request = drogon::HttpRequest::newHttpRequest();
      request->setMethod(method);
      request->setPath("/v1/test/legacy/PRIVATE");
      request->setContentTypeCode(drogon::CT_APPLICATION_JSON);
      request->setBody("{malformed PRIVATE JOURNAL TEXT");
      if (*authorization) request->addHeader("Authorization", authorization);
      beginWriteRequest(request, route);
      CHECK(legacyRestWriteRetired(request));
      drogon::HttpResponsePtr response;
      wrapped(request, [&response](const drogon::HttpResponsePtr& reply) { response = reply; }, "PRIVATE ID");
      REQUIRE(response);
      CHECK_EQ(response->statusCode(), drogon::k410Gone);
      CHECK_EQ(response->contentType(), drogon::CT_APPLICATION_JSON);
      REQUIRE(response->getJsonObject());
      CHECK_EQ(*response->getJsonObject(), expected);
      CHECK_EQ(std::string(response->getBody()), std::string(jsonResponse(expected)->getBody()));
    }
  }
  CHECK_EQ(calls, 0);
  REQUIRE_EQ(capture.lines.size(), std::size_t{8});
  for (const auto& line : capture.lines) {
    CHECK_EQ(line.operation, std::string("test.legacy"));
    CHECK_EQ(line.product, std::string("journal"));
    CHECK_EQ(line.door, std::string("rest"));
    CHECK_EQ(line.outcome, std::string("client-update-required"));
  }
  CHECK(capture.issues.empty());
}

TEST(write_http_retirement_keeps_reads_retained_writes_and_other_doors) {
  LegacyRestRetirement retirement("1");
  HttpWriteCapture capture;
  const auto original = jsonResponse(Json::Value(Json::objectValue));
  const std::vector<WriteRoute> retained{
      {"/v1/test/retained", "test.retained", "gym", "rest", {drogon::Post}},
      {"/v1/test/read", "test.read", "gym", "rest", {drogon::Get}, true},
      {"/v1/test/mcp", "test.mcp", "gym", "mcp", {drogon::Post}, true},
      {"/v1/test/coach", "test.coach", "gym", "coach", {drogon::Post}, true},
      {"/v1/test/sync", "test.sync", "platform", "sync", {drogon::Post}, true},
      {"/v1/test/server", "test.server", "journal", "server", {drogon::Put}, true}};
  int calls = 0;
  auto handler = [&](const drogon::HttpRequestPtr&, WriteHttpCallback&& callback) {
    ++calls;
    callback(original);
  };
  auto unmatched = drogon::HttpRequest::newHttpRequest();
  unmatched->setMethod(drogon::Post);
  CHECK_FALSE(legacyRestWriteRetired(unmatched));
  for (const auto& route : retained) {
    auto request = drogon::HttpRequest::newHttpRequest();
    request->setMethod(route.methods.front());
    auto wrapped = detail::ObservedHttpHandler<decltype(&decltype(handler)::operator())>::wrap(route, handler);
    drogon::HttpResponsePtr response;
    wrapped(request, [&response](const drogon::HttpResponsePtr& reply) { response = reply; });
    CHECK_EQ(response, original);
    CHECK_FALSE(legacyRestWriteRetired(request));
  }
  CHECK_EQ(calls, static_cast<int>(retained.size()));
  REQUIRE_EQ(capture.lines.size(), retained.size());
  for (const auto& line : capture.lines) CHECK_EQ(line.outcome, std::string("ok"));
  CHECK(capture.issues.empty());
}

TEST(write_http_retirement_callback_failures_remain_observed_without_handler_work) {
  LegacyRestRetirement retirement("1");
  HttpWriteCapture capture;
  installWriteReporter(std::shared_ptr<FailureReporter>(&capture, [](FailureReporter*) {}));
  int calls = 0;
  auto handler = [&calls](const drogon::HttpRequestPtr&, WriteHttpCallback&&) { ++calls; };
  const WriteRoute route{"/v1/test/legacy", "test.legacy", "gym", "rest", {drogon::Post}, true};
  auto wrapped = detail::ObservedHttpHandler<decltype(&decltype(handler)::operator())>::wrap(route, handler);
  for (const bool typed : {true, false}) {
    auto request = drogon::HttpRequest::newHttpRequest();
    request->setMethod(drogon::Post);
    bool threw = false;
    try {
      wrapped(request, [typed](const drogon::HttpResponsePtr&) {
        if (typed) throw std::runtime_error("PRIVATE CALLBACK DATA");
        throw 17;
      });
    } catch (const std::runtime_error&) {
      CHECK(typed);
      threw = true;
    } catch (int value) {
      CHECK_FALSE(typed);
      CHECK_EQ(value, 17);
      threw = true;
    }
    CHECK(threw);
  }
  CHECK_EQ(calls, 0);
  REQUIRE_EQ(capture.lines.size(), std::size_t{2});
  REQUIRE_EQ(capture.issues.size(), std::size_t{2});
  for (std::size_t index = 0; index < capture.lines.size(); ++index) {
    CHECK_EQ(capture.lines[index].outcome, std::string("failed"));
    CHECK(capture.issues[index].find(capture.lines[index].requestId) != std::string::npos);
    CHECK(capture.issues[index].find("PRIVATE") == std::string::npos);
  }
}

TEST(write_http_completion_callback_exceptions_report_failed_before_completion) {
  auto capture = std::make_shared<HttpWriteCapture>();
  installWriteReporter(capture);
  auto request = drogon::HttpRequest::newHttpRequest();
  const WriteRoute route{"/v1/test/completion", "test.completion", "journal", "rest", {drogon::Post}};
  auto handler = [](const drogon::HttpRequestPtr&, WriteHttpCallback&& callback) {
    callback(jsonResponse(Json::Value(Json::objectValue)));
  };
  auto wrapped = detail::ObservedHttpHandler<decltype(&decltype(handler)::operator())>::wrap(route, handler);
  bool threw = false;
  try {
    wrapped(request, [](const drogon::HttpResponsePtr&) {
      throw std::runtime_error("PRIVATE COMPLETION DATA");
    });
  } catch (const std::runtime_error& error) {
    threw = true;
    CHECK_EQ(std::string(error.what()), std::string("PRIVATE COMPLETION DATA"));
  }
  CHECK(threw);
  REQUIRE_EQ(capture->lines.size(), std::size_t{1});
  REQUIRE_EQ(capture->issues.size(), std::size_t{1});
  CHECK_EQ(capture->lines[0].operation, std::string("test.completion"));
  CHECK_EQ(capture->lines[0].outcome, std::string("failed"));
  CHECK(capture->issues[0].find(capture->lines[0].requestId) != std::string::npos);
  CHECK(capture->issues[0].find(typeid(std::runtime_error).name()) != std::string::npos);
  CHECK(capture->issues[0].find("PRIVATE") == std::string::npos);
  installWriteReporter({});
}

TEST(write_http_expected_refusals_never_create_issues_and_unsafe_codes_are_discarded) {
  const auto plain = error(drogon::k404NotFound, "no such routine");
  const Json::Value before = *plain->getJsonObject();
  CHECK_EQ(writeHttpOutcome(plain, "gym.write"), std::string("http_404"));
  CHECK_EQ(*plain->getJsonObject(), before);
  CHECK_FALSE(plain->getJsonObject()->isMember("code"));
  CHECK_EQ(writeHttpOutcome(error(drogon::k503ServiceUnavailable, "private", "gym-frozen"), "gym.write"),
           std::string("gym-frozen"));
  CHECK_EQ(writeHttpOutcome(error(drogon::k503ServiceUnavailable, "private", "journal-unavailable"), "journal.write"),
           std::string("journal-unavailable"));
  CHECK_EQ(writeHttpOutcome(error(drogon::k429TooManyRequests, "private"), "gym.write"), std::string("http_429"));
  CHECK_EQ(writeHttpOutcome(error(drogon::k400BadRequest, "private", "PRIVATE TOKEN"), "gym.write"),
           std::string("http_400"));
  CHECK_EQ(writeHttpOutcome(error(drogon::k503ServiceUnavailable, "billing is not configured"),
                           "platform.POST.v1.billing.checkout"), std::string("unavailable"));
  CHECK_EQ(writeHttpOutcome(error(drogon::k502BadGateway, "private"), "gym.write"), std::string("failed"));
}

TEST(write_http_redirect_refusals_are_bounded_outcomes_without_urls_or_response_changes) {
  const auto response = drogon::HttpResponse::newRedirectionResponse(
      "https://private.example/callback?error=invalid_request&state=PRIVATE TOKEN");
  CHECK_EQ(writeHttpOutcome(response, "oauth.authorize"), std::string("invalid_request"));
  CHECK_EQ(response->getHeader("location"),
           std::string("https://private.example/callback?error=invalid_request&state=PRIVATE TOKEN"));
  Json::Value body(Json::objectValue);
  body["redirect"] = "https://private.example/callback?error=access_denied&state=PRIVATE TOKEN";
  CHECK_EQ(writeHttpOutcome(jsonResponse(body), "platform.POST.v1.oauth.decision"), std::string("access_denied"));
  CHECK_EQ(writeHttpOutcome(drogon::HttpResponse::newRedirectionResponse("https://app.example/#/?signin=google_failed"),
                           "auth.google.callback"), std::string("google_failed"));
  CHECK_EQ(writeHttpOutcome(error(drogon::k503ServiceUnavailable, "PRIVATE", "temporarily_unavailable"),
                           "platform.POST.oauth.register"), std::string("temporarily_unavailable"));
}

TEST(write_http_early_refusals_share_the_registration_observation) {
  HttpWriteCapture capture;
  declareWriteRoute({"/v1/test/early/{id}", "test.early", "gym", "rest", {drogon::Post}});
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setPath("/v1/test/early/private");
  request->setMethod(drogon::Post);
  const auto begun = beginWriteRequest(request);
  REQUIRE(begun);
  CHECK_EQ(beginWriteRequest(request)->requestId(), begun->requestId());
  finishWriteRequest(request, error(drogon::k429TooManyRequests, "private"));
  REQUIRE_EQ(capture.lines.size(), std::size_t{1});
  CHECK_EQ(capture.lines[0].operation, std::string("test.early"));
  CHECK_EQ(capture.lines[0].outcome, std::string("http_429"));
  CHECK(capture.issues.empty());
}

TEST(write_http_unexpected_exceptions_keep_the_type_and_request_id_without_message) {
  auto capture = std::make_shared<HttpWriteCapture>();
  installWriteReporter(capture);
  auto request = drogon::HttpRequest::newHttpRequest();
  const WriteRoute route{"/v1/test/failure", "test.failure", "journal", "rest", {drogon::Post}};
  auto handler = [](const drogon::HttpRequestPtr&, WriteHttpCallback&&) {
    throw std::runtime_error("PRIVATE JOURNAL TEXT AND TOKEN");
  };
  auto wrapped = detail::ObservedHttpHandler<decltype(&decltype(handler)::operator())>::wrap(route, handler);
  bool threw = false;
  try { wrapped(request, [](const drogon::HttpResponsePtr&) {}); }
  catch (const std::runtime_error& error) {
    threw = true;
    CHECK_EQ(std::string(error.what()), std::string("PRIVATE JOURNAL TEXT AND TOKEN"));
  }
  CHECK(threw);
  REQUIRE_EQ(capture->lines.size(), std::size_t{1});
  REQUIRE_EQ(capture->issues.size(), std::size_t{1});
  CHECK_EQ(capture->lines[0].outcome, std::string("failed"));
  CHECK(capture->issues[0].find(capture->lines[0].requestId) != std::string::npos);
  CHECK(capture->issues[0].find(typeid(std::runtime_error).name()) != std::string::npos);
  CHECK(capture->issues[0].find("PRIVATE") == std::string::npos);
  installWriteReporter({});
}

TEST(write_http_async_work_retains_request_correlation_and_rethrows_compiled_failures) {
  auto capture = std::make_shared<HttpWriteCapture>();
  installWriteReporter(capture);
  auto request = drogon::HttpRequest::newHttpRequest();
  const auto observation = beginWriteRequest(request,
      {"/v1/test/async", "test.async", "platform", "rest", {drogon::Post}});
  auto callback = observedHttpCallback(request, [&](int value) {
    CHECK_EQ(value, 7);
    CHECK_EQ(writeRequestId(), observation->requestId());
    throw std::runtime_error("PRIVATE ASYNC CONTENT");
  });
  bool threw = false;
  try { callback(7); }
  catch (const std::runtime_error& error) {
    threw = true;
    CHECK_EQ(std::string(error.what()), std::string("PRIVATE ASYNC CONTENT"));
  }
  CHECK(threw);
  REQUIRE_EQ(capture->lines.size(), std::size_t{1});
  REQUIRE_EQ(capture->issues.size(), std::size_t{1});
  CHECK_EQ(capture->lines[0].requestId, observation->requestId());
  CHECK_EQ(capture->lines[0].operation, std::string("test.async"));
  CHECK_EQ(capture->lines[0].outcome, std::string("failed"));
  CHECK(capture->issues[0].find(typeid(std::runtime_error).name()) != std::string::npos);
  CHECK(capture->issues[0].find("PRIVATE") == std::string::npos);
  installWriteReporter({});
}

TEST(write_http_unexpected_server_status_creates_one_issue) {
  auto capture = std::make_shared<HttpWriteCapture>();
  installWriteReporter(capture);
  auto request = drogon::HttpRequest::newHttpRequest();
  beginWriteRequest(request, {"/v1/test/status", "test.status", "gym", "rest", {drogon::Post}});
  const auto response = error(drogon::k500InternalServerError, "PRIVATE DATA");
  finishWriteRequest(request, response);
  finishWriteRequest(request, response);
  REQUIRE_EQ(capture->lines.size(), std::size_t{1});
  REQUIRE_EQ(capture->issues.size(), std::size_t{1});
  CHECK_EQ(capture->lines[0].outcome, std::string("failed"));
  CHECK(capture->issues[0].find("HttpWriteFailure") != std::string::npos);
  CHECK(capture->issues[0].find("PRIVATE") == std::string::npos);
  installWriteReporter({});
}

TEST(write_http_shared_exception_handler_omits_secret_queries_and_preserves_the_500_body) {
  auto capture = std::make_shared<HttpWriteCapture>();
  installWriteReporter(capture);
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setPath("/v1/test/exception");
  request->setParameter("token", "PRIVATE_TOKEN");
  const auto observation = beginWriteRequest(request,
      {"/v1/test/exception", "test.exception", "gym", "rest", {drogon::Post}});
  auto& app = drogon::app();
  auto previous = app.getExceptionHandler();
  installPrivacySafeExceptionHandler(app, {}, true);
  drogon::HttpResponsePtr response;
  app.getExceptionHandler()(std::runtime_error("PRIVATE_TOKEN PRIVATE_JOURNAL_TEXT"), request,
      [&response](const drogon::HttpResponsePtr& reply) { response = reply; });
  app.setExceptionHandler(std::move(previous));
  REQUIRE(response);
  CHECK_EQ(response->statusCode(), drogon::k500InternalServerError);
  Json::Value body(Json::objectValue);
  body["error"] = "internal error";
  CHECK_EQ(std::string(response->getBody()), std::string(jsonResponse(body, drogon::k500InternalServerError)->getBody()));
  REQUIRE_EQ(capture->lines.size(), std::size_t{1});
  REQUIRE_EQ(capture->issues.size(), std::size_t{1});
  CHECK_EQ(capture->lines[0].operation, std::string("test.exception"));
  CHECK_EQ(capture->lines[0].requestId, observation->requestId());
  CHECK(capture->issues[0].find("PRIVATE") == std::string::npos);
  installWriteReporter({});
}

TEST(write_http_shared_exception_handler_preserves_the_framework_500_bytes) {
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setPath("/v1/test/framework-exception");
  request->setParameter("token", "PRIVATE_TOKEN");
  auto& app = drogon::app();
  const auto expected = app.getCustomErrorHandler()(drogon::k500InternalServerError, request);
  auto previous = app.getExceptionHandler();
  installPrivacySafeExceptionHandler(app);
  drogon::HttpResponsePtr response;
  app.getExceptionHandler()(std::runtime_error("PRIVATE_TOKEN"), request,
      [&response](const drogon::HttpResponsePtr& reply) { response = reply; });
  app.setExceptionHandler(std::move(previous));
  REQUIRE(response);
  CHECK_EQ(response->statusCode(), expected->statusCode());
  CHECK_EQ(response->contentType(), expected->contentType());
  CHECK_EQ(std::string(response->getBody()), std::string(expected->getBody()));
}

TEST(write_http_inventory_covers_every_registered_mutating_route) {
  const auto backend = backendPath();
  REQUIRE(std::filesystem::exists(backend / "platform/infra/main.cpp"));
  const std::regex call(R"(([a-zA-Z_][a-zA-Z_0-9]*)\.register(Write|LegacyWrite)?Handler\s*\()");
  const std::regex verb(R"(drogon::(Post|Put|Patch|Delete))");
  std::size_t writes = 0;
  for (const auto& entry : std::filesystem::recursive_directory_iterator(backend)) {
    if (entry.path().extension() != ".cpp" && entry.path().extension() != ".h") continue;
    const std::string relative = std::filesystem::relative(entry.path(), backend).generic_string();
    if (relative.rfind("test/", 0) == 0 || relative.rfind("deploy/", 0) == 0 ||
        relative == "platform/adapters/http/WriteRoutes.h") continue;
    const std::string source = sourceText(entry.path());
    CHECK(source.find("METHOD_ADD(") == std::string::npos);
    CHECK(source.find("ADD_METHOD_TO(") == std::string::npos);
    CHECK(source.find("registerHandlerViaRegex(") == std::string::npos);
    if (relative != "platform/adapters/ws/SyncSocket.cpp")
      CHECK(source.find("registerController(") == std::string::npos);
    for (auto match = std::sregex_iterator(source.begin(), source.end(), call);
         match != std::sregex_iterator(); ++match) {
      const auto begin = static_cast<std::size_t>(match->position() + match->length());
      int depth = 1;
      bool quoted = false;
      bool escaped = false;
      auto end = begin;
      for (; end < source.size() && depth; ++end) {
        const char byte = source[end];
        if (escaped) { escaped = false; continue; }
        if (quoted && byte == '\\') { escaped = true; continue; }
        if (byte == '"') { quoted = !quoted; continue; }
        if (quoted) continue;
        if (byte == '(') ++depth;
        if (byte == ')') --depth;
      }
      const std::string registration = source.substr(begin, end - begin);
      const std::string receiver = (*match)[1].str();
      CHECK(source.find("WriteRoutes " + receiver + "(") != std::string::npos);
      if (!(*match)[2].matched && !std::regex_search(registration, verb)) continue;
      ++writes;
    }
  }
  CHECK(writes >= 88);
  std::cout << "observability route inventory: " << writes << " registered write routes\n";
  const std::string main = sourceText(backend / "platform/infra/main.cpp");
  for (const char* path : {"/v1/auth/google/start", "/v1/auth/google/callback", "/oauth/authorize"}) {
    const std::regex registration(std::string(R"(routes\.registerWriteHandler\s*\(\s*"[^"]+"\s*,\s*")") + path + "\"");
    CHECK(std::regex_search(main, registration));
  }
}

TEST(write_http_registered_retired_routes_equal_each_products_retained_route_ledger) {
  auto& app = drogon::app();
  static auto clock = std::make_shared<SystemClock>();
  gym::GymDeps gymDeps{};
  gymDeps.clock = clock;
  gymDeps.onShutdown = [](std::function<void()> stop) { stop(); };
  gym::registerRoutes(app, gymDeps);
  journal::registerRoutes(app, journal::JournalDeps{});

  const std::regex row(R"(\|\s*`?(GET|POST|PUT|PATCH|DELETE)`?\s*\|\s*`([^`]+)`\s*\|\s*(Retire|Keep)\s*\|)");
  for (const std::string product : {"gym", "journal"}) {
    std::set<std::pair<std::string, std::string>> registered;
    for (const auto& route : registeredWriteRoutes()) {
      if (route.product != product || route.door != "rest" || !route.legacyRestWrite) continue;
      for (const auto method : route.methods) {
        CHECK(mutatingMethod(method));
        CHECK(registered.emplace(std::string(drogon::to_string_view(method)), route.path).second);
      }
    }
    std::set<std::pair<std::string, std::string>> ledger;
    const std::string architecture = sourceText(backendPath() / "products" / product / "ARCHITECTURE.md");
    for (auto match = std::sregex_iterator(architecture.begin(), architecture.end(), row);
         match != std::sregex_iterator(); ++match) {
      if ((*match)[3].str() != "Retire") continue;
      CHECK(ledger.emplace((*match)[1].str(), (*match)[2].str()).second);
    }
    CHECK_FALSE(registered.empty());
    CHECK_EQ(registered, ledger);
    std::cout << product << " retirement ledger: " << registered.size() << " registered routes\n";
  }
}
