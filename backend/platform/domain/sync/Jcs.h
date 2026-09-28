#pragma once

#include <json/json.h>

#include <compare>
#include <stdexcept>
#include <string>
#include <string_view>

namespace wm::sync {

// A text that is not strict JSON, or a value that has no JSON text: a non-finite number, or a string
// that is not UTF-8 (a lone surrogate included).
struct JsonError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// RFC 8785, the engine's one encoding (§3.2 `jcs`): object keys in UTF-16 code unit order, every
// number printed as ECMAScript prints its double (-0 as 0), and strings escaping only '"', '\' and
// the control characters. Throws JsonError.
std::string jcs(const Json::Value& value);

// RFC 8259 with nothing lenient: any value at the root, no comments, no duplicate keys, nothing after
// the value, every string and key UTF-8 with its control characters escaped, and arrays and objects
// nested at most 1000 deep. A number is §9.1's: a finite double, zero only when every digit of its
// literal is, and an integer literal that Int64 or UInt64 holds stays that integer. Throws JsonError.
Json::Value parseJson(std::string_view text);

// §9.1 Integers: every integer on the wire is a JSON safe integer, at most 2^53 − 1 in magnitude.
bool isSafeInteger(const Json::Value& value);

// The "bytewise" order of §3.2: the UTF-8 bytes of the two encodings, which differs from UTF-16 order
// above U+FFFF.
std::strong_ordering compareJcs(const Json::Value& a, const Json::Value& b);

}
