#include "products/gym/adapters/http/GymSchema.h"
#include "test/testing.h"
#include "test/DrogonLoopback.h"

#include <string>

using namespace wm;
using namespace wm::gym;

TEST(gym_http_schema_requires_a_current_decimal_int64_carrier) {
  CHECK_EQ(gymSchemaRefusal(std::nullopt, 10)->statusCode(), drogon::k426UpgradeRequired);
  for (const auto& value : {"8", "9", "0", "-1", "-9223372036854775808"}) {
    const auto response = gymSchemaRefusal(value, 10);
    REQUIRE(response);
    CHECK_EQ(response->statusCode(), drogon::k426UpgradeRequired);
    CHECK_EQ((*response->getJsonObject())["code"].asString(), std::string("client-update-required"));
  }
  for (const auto& value : {"10", "11", "010", "9223372036854775807"})
    CHECK_FALSE(gymSchemaRefusal(value, 10));
  for (const auto& value : {"", " ", " 10", "10 ", "+10", "10.0", "10,11", "-", "9223372036854775808", "-9223372036854775809"}) {
    const auto response = gymSchemaRefusal(value, 10);
    REQUIRE(response);
    CHECK_EQ(response->statusCode(), drogon::k400BadRequest);
    CHECK_EQ((*response->getJsonObject())["code"].asString(), std::string("malformed"));
  }
}

TEST(gym_http_schema_uses_the_first_repeated_carrier_and_preserves_retired_and_options) {
  wm::test::DrogonLoopback::Connection connection;
  const auto parsed = connection.exchange("GET /gym-schema HTTP/1.1\r\nHost: fixture\r\nSync-Schema: 9\r\nSync-Schema: 10\r\n\r\n");
  auto request = parsed.request;
  REQUIRE(request);
  REQUIRE(gymSchemaRefusal(request, 10));
  CHECK_EQ(gymSchemaRefusal(request, 10)->statusCode(), drogon::k426UpgradeRequired);
  request->attributes()->insert("wm.retired_route", true);
  CHECK_FALSE(gymSchemaRefusal(request, 10));
  request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Options);
  CHECK_FALSE(gymSchemaRefusal(request, 10));
}

TEST(gym_http_schema_stops_a_handler_before_json_stream_or_photo_side_effects) {
  int admitted = 0;
  auto handler = [&admitted](const drogon::HttpRequestPtr&, WriteHttpCallback&& callback, const std::string& id) {
    ++admitted;
    CHECK_EQ(id, std::string("fixture"));
    callback(drogon::HttpResponse::newHttpResponse());
  };
  auto guarded = wm::gym::detail::GymSchemaHandler<decltype(&decltype(handler)::operator())>::wrap(10, handler);
  for (const auto& carrier : {"", "9", "malformed", "10"}) {
    auto request = drogon::HttpRequest::newHttpRequest();
    if (*carrier) request->addHeader("Sync-Schema", carrier);
    drogon::HttpResponsePtr response;
    guarded(request, [&response](const auto& answer) { response = answer; }, "fixture");
    REQUIRE(response);
    CHECK_EQ(response->statusCode(), std::string(carrier) == "10" ? drogon::k200OK :
        std::string(carrier) == "malformed" ? drogon::k400BadRequest : drogon::k426UpgradeRequired);
  }
  CHECK_EQ(admitted, 1);
}
