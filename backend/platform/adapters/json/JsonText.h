#pragma once

#include <json/json.h>

#include <string>

namespace wm {

// The compact JSON boundary: a Json::Value to its shortest string and back, so the serialization is
// byte-identical wherever it happens. parse fails soft — an unparseable or over-nested payload
// returns a null value rather than throwing.
//
// A double is written to kJsonDoubleDigits significant digits, not jsoncpp's default 17: at 17 a
// value with no exact double prints its noise (`82.4` → `82.400000000000006`), at 15 it prints the
// number a person wrote and a double two decimals wide reads back unchanged. Drogon writes its own
// replies, so `configureJsonReplies` (adapters/http/JsonReply.h) hands it the same number — one rule
// for every wire this process serves.
constexpr unsigned kJsonDoubleDigits = 15;

std::string dump(const Json::Value& value);
Json::Value parse(const std::string& text);

}
