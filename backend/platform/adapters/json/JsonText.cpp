#include "platform/adapters/json/JsonText.h"

#include <memory>
#include <optional>
#include <string>

namespace wm {

std::string dump(const Json::Value& value) {
  Json::StreamWriterBuilder builder;
  builder["indentation"] = "";
  builder["precision"] = kJsonDoubleDigits;
  builder["precisionType"] = "significant";
  return Json::writeString(builder, value);
}

Json::Value parse(const std::string& text) {
  Json::Value root;
  Json::CharReaderBuilder builder;
  std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  std::string errors;
  // jsoncpp throws (not just returns false) once nesting passes its stack limit. Swallow it to a
  // null value — callers already treat a non-object frame as "ignore".
  try {
    reader->parse(text.c_str(), text.c_str() + text.size(), &root, &errors);
  } catch (const std::exception&) {
    return Json::Value(Json::nullValue);
  }
  return root;
}

std::optional<Json::Value> parseWhole(const std::string& text) {
  Json::Value root;
  Json::CharReaderBuilder builder;
  builder["failIfExtra"] = true;
  std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  std::string errors;
  try {
    if (!reader->parse(text.c_str(), text.c_str() + text.size(), &root, &errors)) return std::nullopt;
  } catch (const std::exception&) {
    return std::nullopt;
  }
  return root;
}

}
