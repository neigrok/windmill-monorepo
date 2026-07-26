#pragma once

#include <json/json.h>

#include <string>

namespace wm {

// The compact JSON boundary: a Json::Value to its shortest string and back. Product-neutral —
// every edge that persists or ships a payload (events, the op log, the wire) shares this pair,
// so the serialization is byte-identical wherever it happens. parse fails soft: an unparseable
// or over-nested payload returns a null value rather than throwing, since callers already treat
// a non-object frame as "ignore".
std::string dump(const Json::Value& value);
Json::Value parse(const std::string& text);

}
