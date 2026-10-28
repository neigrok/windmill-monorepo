#include "platform/adapters/http/JsonReply.h"
#include "platform/adapters/json/JsonText.h"
#include "test/testing.h"

#include <bit>
#include <cmath>
#include <cstdint>
#include <limits>

using namespace wm;

TEST(json_dump_and_http_replies_preserve_every_finite_double_bit) {
  for (const double number : {std::numeric_limits<double>::max(), -std::numeric_limits<double>::max(),
                              82.4, 35333333333333.34, 1.2345678901234567}) {
    Json::Value body(Json::objectValue);
    body["number"] = number;
    const auto response = jsonResponse(body);
    for (const std::string encoded : {dump(body), std::string(response->body())}) {
      const auto decoded = parse(encoded);
      REQUIRE(decoded["number"].isDouble());
      CHECK(std::isfinite(decoded["number"].asDouble()));
      CHECK_EQ(std::bit_cast<std::uint64_t>(decoded["number"].asDouble()), std::bit_cast<std::uint64_t>(number));
    }
  }
}

TEST(json_dump_and_http_replies_preserve_full_width_integers) {
  Json::Value body(Json::objectValue);
  body["signed"] = Json::Int64(std::numeric_limits<std::int64_t>::min());
  body["unsigned"] = Json::UInt64(std::numeric_limits<std::uint64_t>::max());
  const auto response = jsonResponse(body);
  for (const std::string encoded : {dump(body), std::string(response->body())}) {
    CHECK_EQ(encoded, std::string(R"({"signed":-9223372036854775808,"unsigned":18446744073709551615})"));
    const auto decoded = parse(encoded);
    CHECK_EQ(decoded["signed"].asInt64(), std::numeric_limits<std::int64_t>::min());
    CHECK_EQ(decoded["unsigned"].asUInt64(), std::numeric_limits<std::uint64_t>::max());
  }
}
