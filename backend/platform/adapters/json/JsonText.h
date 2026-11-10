#pragma once

#include <json/json.h>

#include <optional>
#include <string>

namespace wm {

// The compact JSON boundary: a Json::Value to its string and back, so the serialization is
// byte-identical wherever it happens. parse fails soft — an over-nested payload returns a null value
// rather than throwing, and text that breaks part way returns what was read before the break.
// parseWhole is the strict reading for what a client sends: nullopt unless the whole text is one
// JSON value, so no part of a broken frame is ever taken for the frame.
//
// Seventeen significant digits round-trip every finite double. Drogon writes its own replies, so
// `configureJsonReplies` (adapters/http/JsonReply.h) carries the same precision on every wire.
constexpr unsigned kJsonDoubleDigits = 17;

std::string dump(const Json::Value& value);
Json::Value parse(const std::string& text);
std::optional<Json::Value> parseWhole(const std::string& text);

}
