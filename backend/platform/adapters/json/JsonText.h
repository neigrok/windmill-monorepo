#pragma once

#include <json/json.h>

#include <string>

namespace wm {

// The compact JSON boundary: a Json::Value to its string and back, so the serialization is
// byte-identical wherever it happens. parse fails soft — an unparseable or over-nested payload
// returns a null value rather than throwing.
//
// Seventeen significant digits round-trip every finite double. Drogon writes its own replies, so
// `configureJsonReplies` (adapters/http/JsonReply.h) carries the same precision on every wire.
constexpr unsigned kJsonDoubleDigits = 17;

std::string dump(const Json::Value& value);
Json::Value parse(const std::string& text);

}
