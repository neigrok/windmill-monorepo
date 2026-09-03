#include "products/roadmap/adapters/mcp/ToolArgs.h"

#include "products/roadmap/domain/Command.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace wm {

namespace {

std::string quoted(const std::string& path) { return "\"" + path + "\""; }

std::string missing(const std::string& path) { return "missing required argument " + quoted(path); }

std::string wrongType(const std::string& path, const char* wanted, const Json::Value& value) {
  return "argument " + quoted(path) + " must be " + wanted + ", got " + typeName(value);
}

std::string at(const std::string& path, Json::ArrayIndex index) {
  return path + "[" + std::to_string(index) + "]";
}

std::string tooLong(const std::string& path, std::size_t given, std::size_t limit) {
  return path + " is " + std::to_string(given) + " characters, max " + std::to_string(limit);
}

std::string set(const std::vector<const char*>& legal) {
  std::string out = "{";
  for (const char* value : legal) {
    if (out.size() > 1) out += ", ";
    out += value;
  }
  return out + "}";
}

std::string joined(const std::string& path, const char* field) {
  return path.empty() ? std::string(field) : path + "." + field;
}

// The shortest spelling that reads back as the same double: jsoncpp writes 17 significant
// digits, so a caller who sent 0.1 would be told it sent 0.10000000000000001.
std::string shortestNumber(double value) {
  char buffer[32];
  for (int digits : {15, 16, 17}) {
    std::snprintf(buffer, sizeof(buffer), "%.*g", digits, value);
    if (std::strtod(buffer, nullptr) == value) return buffer;
  }
  return buffer;
}

}  // namespace

std::string typeName(const Json::Value& value) {
  if (value.isNull()) return "null";
  if (value.isBool()) return "boolean";
  if (value.isNumeric()) return "number";
  if (value.isString()) return "string";
  if (value.isArray()) return "array";
  return "object";
}

std::string literal(const Json::Value& value) {
  if (value.isArray() || value.isObject()) return "an " + typeName(value);  // never a wall of JSON
  if (value.isString() && value.asString().size() > 64)
    return "a " + std::to_string(value.asString().size()) + "-character string";
  // jsoncpp writes an infinity as a number no parser reads back, so a non-finite value is named.
  if (value.isDouble() && !std::isfinite(value.asDouble())) {
    if (std::isnan(value.asDouble())) return "NaN";
    return value.asDouble() > 0 ? "infinity" : "-infinity";
  }
  if (value.type() == Json::realValue) return shortestNumber(value.asDouble());
  Json::StreamWriterBuilder builder;
  builder["indentation"] = "";
  return Json::writeString(builder, value);
}

std::optional<std::string> requireString(const Json::Value& value, const std::string& path, Empty empty,
                                         std::size_t limit) {
  if (value.isNull()) return missing(path);
  if (std::optional<std::string> bad = optionalString(value, path, limit)) return bad;
  if (empty == Empty::rejected && value.asString().empty())
    return "argument " + quoted(path) + " must be a non-empty string, got \"\"";
  return std::nullopt;
}

std::optional<std::string> optionalString(const Json::Value& value, const std::string& path,
                                          std::size_t limit) {
  if (value.isNull()) return std::nullopt;
  if (!value.isString()) return wrongType(path, "a string", value);
  if (limit > 0 && value.asString().size() > limit) return tooLong(path, value.asString().size(), limit);
  return std::nullopt;
}

std::optional<std::string> requireNumber(const Json::Value& value, const std::string& path) {
  if (value.isNull()) return missing(path);
  return optionalNumber(value, path);
}

std::optional<std::string> optionalNumber(const Json::Value& value, const std::string& path) {
  if (value.isNull()) return std::nullopt;
  if (!value.isNumeric()) return wrongType(path, "a number", value);
  if (!std::isfinite(value.asDouble()))
    return "argument " + quoted(path) + " must be a finite number, got " + literal(value);
  return std::nullopt;
}

std::optional<std::string> optionalBool(const Json::Value& value, const std::string& path) {
  if (value.isNull()) return std::nullopt;
  if (!value.isBool()) return wrongType(path, "a boolean", value);
  return std::nullopt;
}

std::optional<std::string> requireOneOf(const Json::Value& value, const std::string& path,
                                        const std::vector<const char*>& legal) {
  if (value.isNull()) return missing(path) + ", one of " + set(legal);
  return optionalOneOf(value, path, legal);
}

std::optional<std::string> optionalOneOf(const Json::Value& value, const std::string& path,
                                         const std::vector<const char*>& legal) {
  if (value.isNull()) return std::nullopt;
  if (!value.isString()) return wrongType(path, "a string", value) + ", one of " + set(legal);
  for (const char* candidate : legal)
    if (value.asString() == candidate) return std::nullopt;
  return path + " " + literal(value) + " is not one of " + set(legal);
}

std::optional<std::string> requireObjects(const Json::Value& value, const std::string& path,
                                          std::size_t limit) {
  if (value.isNull()) return missing(path);
  return optionalObjects(value, path, limit);
}

std::optional<std::string> optionalObjects(const Json::Value& value, const std::string& path,
                                           std::size_t limit) {
  if (value.isNull()) return std::nullopt;
  if (!value.isArray()) return wrongType(path, "an array of objects", value);
  if (limit > 0 && value.size() > limit)
    return path + " has " + std::to_string(value.size()) + " items, max " + std::to_string(limit);
  for (Json::ArrayIndex i = 0; i < value.size(); ++i) {
    if (value[i].isObject()) continue;
    const std::string item = at(path, i) + " must be an object, got " + typeName(value[i]);
    if (value[i].isString()) return item + ". Each item is a JSON object, not a JSON-encoded string.";
    return item;
  }
  return std::nullopt;
}

std::optional<std::string> optionalStrings(const Json::Value& value, const std::string& path,
                                           std::size_t itemLimit) {
  if (value.isNull()) return std::nullopt;
  if (!value.isArray()) return wrongType(path, "an array of strings", value);
  for (Json::ArrayIndex i = 0; i < value.size(); ++i) {
    const std::string item = at(path, i);
    if (!value[i].isString() || value[i].asString().empty())
      return item + " must be a non-empty string, got " + literal(value[i]);
    if (itemLimit > 0 && value[i].asString().size() > itemLimit)
      return tooLong(item, value[i].asString().size(), itemLimit);
  }
  return std::nullopt;
}

std::optional<std::string> optionalObject(const Json::Value& value, const std::string& path) {
  if (value.isNull()) return std::nullopt;
  if (!value.isObject()) return wrongType(path, "an object", value);
  return std::nullopt;
}

std::optional<std::string> optionalLinks(const Json::Value& value, const std::string& path) {
  if (value.isNull()) return std::nullopt;
  if (!value.isArray()) return wrongType(path, "an array of links", value);
  if (value.size() > kMaxNodeLinks)
    return path + " has " + std::to_string(value.size()) + " items, max " + std::to_string(kMaxNodeLinks);
  for (Json::ArrayIndex i = 0; i < value.size(); ++i) {
    const std::string item = at(path, i);
    if (value[i].isString()) {
      if (std::optional<std::string> bad = requireString(value[i], item, Empty::rejected, kMaxLinkUrlLength))
        return bad;
      continue;
    }
    if (!value[i].isObject())
      return item + " must be an object {url, label?} or a url string, got " + typeName(value[i]);
    if (std::optional<std::string> bad =
            requireString(value[i]["url"], item + ".url", Empty::rejected, kMaxLinkUrlLength))
      return bad;
    if (std::optional<std::string> bad =
            optionalString(value[i]["label"], item + ".label", kMaxLinkLabelLength))
      return bad;
  }
  return std::nullopt;
}

std::optional<std::string> requireHandle(const Json::Value& args, const Handle& handle,
                                         const std::string& path, std::string& out) {
  // Guarded here, not at the call sites: this module must refuse in words, never by throwing,
  // and jsoncpp throws on a keyed read of a non-object.
  if (!args.isNull() && !args.isObject())
    return (path.empty() ? std::string("arguments") : path) + " must be an object, got " + typeName(args);

  const bool published = !args[handle.published].isNull();
  const Json::Value& given = published ? args[handle.published] : args[handle.alias];
  if (given.isNull()) return missing(joined(path, handle.published)) + ". " + handle.hint;
  // The message names the spelling the caller actually used, so an alias reads back as itself.
  const std::string field = joined(path, published ? handle.published : handle.alias);
  if (std::optional<std::string> bad = requireString(given, field, Empty::rejected, kMaxIdLength))
    return bad;
  out = given.asString();
  return std::nullopt;
}

}
