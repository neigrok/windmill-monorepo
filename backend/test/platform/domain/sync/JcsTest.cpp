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
  CHECK(refused("[01]"));                    // a leading zero
  CHECK(refused("[1.]"));
  CHECK(refused("[.5]"));
  CHECK(refused("[-]"));
  CHECK(refused("[1e]"));
  CHECK(refused("[+1]"));
  CHECK(refused("\xef\xbb\xbf[1]"));          // a byte order mark
  CHECK(refused("[\"a\tb\"]"));              // a control character left unescaped
  CHECK(refused(R"(["\x"])"));              // an unknown escape
  CHECK(refused(R"(["\u12"])"));
  CHECK(refused(R"({"a":1,"\u0061":2})"));   // a key repeated once its escapes are read
  CHECK(refused("\"\xff\""));                // a byte no UTF-8 text holds
  CHECK(refused("\"\xc0\xaf\""));            // an overlong '/'
  CHECK(refused("\"\xed\xa0\x80\""));        // a surrogate spelled in UTF-8
  CHECK(refused(R"(["\udc00"])"));           // a lone low surrogate, escaped
  CHECK(refused("{\"\xff\":1}"));            // keys are checked as values are
}

// §9.1 Numbers: a literal that is no finite double, or a nonzero one that rounds to zero, is refused; zero spelled
// with any exponent and every subnormal are read. The bounds are half the smallest subnormal, 2^-1075, which rounds
// to zero, and the largest double plus half its step, which rounds past it.
TEST(parse_json_reads_a_number_as_the_finite_double_it_rounds_to_and_refuses_one_rounding_to_zero_from_nonzero) {
  CHECK(refused("1e400"));
  CHECK(refused("-1e400"));
  CHECK(refused("1.79769313486231580793728971405303415079934132710037826936173778980444968292764750946649018e308"));
  CHECK(refused(std::string("1") + std::string(309, '0')));
  CHECK(refused("1e-400"));
  CHECK(refused("-1e-400"));
  CHECK(refused("2.4703282292062327e-324"));
  CHECK(refused("0.00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
                "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
                "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001"));
  CHECK_EQ(jcs(parseJson("1.79769313486231580793728971405303415079934132710037826936173778980444968292764750946649017e308")),
           std::string("1.7976931348623157e+308"));
  CHECK_EQ(jcs(parseJson("2.4703282292062328e-324")), std::string("5e-324"));
  CHECK_EQ(jcs(parseJson("5e-324")), std::string("5e-324"));
  CHECK_EQ(jcs(parseJson("-1e-310")), std::string("-1e-310"));
  CHECK_EQ(jcs(parseJson("0e-400")), std::string("0"));
  CHECK_EQ(jcs(parseJson("-0.000e999999999999")), std::string("0"));
}

TEST(parse_json_keeps_an_integer_literal_that_int64_or_uint64_holds_and_reads_a_longer_one_as_a_double) {
  const Json::Value low = parseJson("-9223372036854775808");
  const Json::Value high = parseJson("18446744073709551615");
  const Json::Value beyond = parseJson("18446744073709551616");
  CHECK(low.isInt64() && low.asInt64() == std::numeric_limits<std::int64_t>::min());
  CHECK(high.isUInt64() && high.asUInt64() == std::numeric_limits<std::uint64_t>::max());
  CHECK(beyond.type() == Json::realValue && beyond.asDouble() == 18446744073709551616.0);
  CHECK(parseJson("7").type() == Json::intValue);
  CHECK(parseJson("7.0").type() == Json::realValue);
}

TEST(parse_json_nests_arrays_and_objects_at_most_1000_deep) {
  auto nested = [](int depth) { return std::string(static_cast<std::size_t>(depth), '[') + std::string(static_cast<std::size_t>(depth), ']'); };
  CHECK_FALSE(refused(nested(1000)));
  CHECK(refused(nested(1001)));
  CHECK(refused(nested(1'000'000)));
}

TEST(parse_json_reads_escapes_into_utf8_a_nul_included) {
  CHECK_EQ(parseJson(R"("a\u0000b")").asString(), std::string("a\0b", 3));
  CHECK_EQ(parseJson(R"("\ud83d\ude00\u00E9\/")").asString(), std::string("\xf0\x9f\x98\x80\xc3\xa9/"));
  CHECK_EQ(jcs(parseJson("{\"a\\u0000\":1,\"a\":2}")), std::string(R"({"a":2,"a\u0000":1})"));
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
    CHECK_EQ(jcs(parseJson(text)), text);
  }
}
