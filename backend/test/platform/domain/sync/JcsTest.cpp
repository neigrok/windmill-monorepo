#include "platform/domain/sync/Jcs.h"

#include "test/testing.h"

#include <bit>
#include <cmath>
#include <cstdlib>
#include <cstdint>
#include <limits>
#include <random>
#include <string>

using namespace wm::sync;

// RFC 8785's number and string rules are pinned by sync_corpus/jcs/values.json; these cases cover the
// parser's strictness and what the corpus cannot enumerate.

namespace {

bool refused(const std::string& text) {
  try {
    parseJson(text);
    return false;
  } catch (const JsonError&) {
    return true;
  }
}

}

TEST(parse_json_refuses_every_lenient_reading) {
  CHECK(refused(""));
  CHECK(refused(R"({"a":1,"a":2})"));        // a duplicate key
  CHECK(refused("[1] // a comment"));
  CHECK(refused("[1] 2"));                   // text after the value
  CHECK(refused("[1,]"));
  CHECK(refused("{'a':1}"));
  CHECK(refused("[NaN]"));
  CHECK(refused("[Infinity]"));
  CHECK(refused("[1e400]"));                 // no finite double
  CHECK(refused("\"\xff\""));                // a byte no UTF-8 text holds
  CHECK(refused("\"\xc0\xaf\""));            // an overlong '/'
  CHECK(refused("\"\xed\xa0\x80\""));        // a surrogate spelled in UTF-8
  CHECK(refused(R"(["\udc00"])"));           // a lone low surrogate, escaped
  CHECK(refused("{\"\xff\":1}"));            // keys are checked as values are
}

TEST(parse_json_reads_any_value_at_the_root) {
  CHECK_EQ(jcs(parseJson("1")), std::string("1"));
  CHECK_EQ(jcs(parseJson(R"("x")")), std::string(R"("x")"));
  CHECK_EQ(jcs(parseJson("null")), std::string("null"));
  CHECK_EQ(jcs(parseJson(" [ ] ")), std::string("[]"));
}

TEST(jcs_prints_an_integer_and_the_equal_double_alike) {
  CHECK_EQ(jcs(Json::Value(Json::Int64(5))), std::string("5"));
  CHECK_EQ(jcs(Json::Value(5.0)), std::string("5"));
  CHECK_EQ(jcs(Json::Value(Json::Int64(-7))), std::string("-7"));
  // Integers past 2^53 print as the double they read as, as every JSON reader of the engine sees them.
  CHECK_EQ(jcs(Json::Value(std::numeric_limits<Json::UInt64>::max())), std::string("18446744073709552000"));
  CHECK_EQ(jcs(parseJson("9007199254740993")), std::string("9007199254740992"));
}

TEST(jcs_escapes_a_nul_and_keeps_its_length) {
  CHECK_EQ(jcs(Json::Value(std::string("a\0b", 3))), std::string(R"("a\u0000b")"));
}

TEST(jcs_refuses_a_value_that_has_no_json_text) {
  for (const Json::Value& value : {Json::Value(std::string("\xff")), Json::Value(std::nan("")),
                                   Json::Value(-std::numeric_limits<double>::infinity())}) {
    bool threw = false;
    try {
      jcs(value);
    } catch (const JsonError&) {
      threw = true;
    }
    CHECK(threw);
  }
  Json::Value keyed(Json::objectValue);
  keyed["\xff"] = 1;
  bool threw = false;
  try {
    jcs(keyed);
  } catch (const JsonError&) {
    threw = true;
  }
  CHECK(threw);
}

TEST(compare_jcs_orders_by_utf8_bytes_not_utf16_units) {
  const Json::Value dalet("\xef\xac\xb3");    // U+FB33, one UTF-16 unit above the surrogates
  const Json::Value grin("\xf0\x9f\x98\x80");  // U+1F600, a surrogate pair in UTF-16
  CHECK(compareJcs(dalet, grin) < 0);
  CHECK(compareJcs(Json::Value(9), Json::Value(10)) > 0);   // "9" > "10"
  CHECK(compareJcs(Json::Value(9), Json::Value(9.0)) == 0);
}

TEST(jcs_of_any_finite_double_reads_back_as_that_double) {
  std::mt19937_64 random(20260927);
  for (int i = 0; i < 20000; ++i) {
    const double number = std::bit_cast<double>(random());
    if (!std::isfinite(number)) continue;
    const std::string text = jcs(Json::Value(number));
    CHECK(std::strtod(text.c_str(), nullptr) == number);
    // jsoncpp over libc++ (macOS) refuses a subnormal number, its stream read reporting the underflow.
    if (std::fpclassify(number) == FP_NORMAL) CHECK_EQ(jcs(parseJson(text)), text);
  }
}
