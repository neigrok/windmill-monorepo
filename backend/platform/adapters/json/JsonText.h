#pragma once

#include <json/json.h>

#include <string>

namespace wm {

// The compact JSON boundary: a Json::Value to its shortest string and back, so the serialization is
// byte-identical wherever it happens. parse fails soft — an unparseable or over-nested payload
// returns a null value rather than throwing.
std::string dump(const Json::Value& value);
Json::Value parse(const std::string& text);

}
