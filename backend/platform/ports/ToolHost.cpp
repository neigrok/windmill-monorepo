#include "platform/ports/ToolHost.h"

namespace wm {

namespace {

// The properties an object schema declares, comma-joined — what a refusal offers instead of the key
// it rejected.
std::string declaredKeys(const Json::Value& schema) {
  std::string out;
  for (const std::string& property : schema["properties"].getMemberNames()) {
    if (!out.empty()) out += ", ";
    out += property;
  }
  return out.empty() ? "no arguments" : out;
}

// Every object the schema closes is checked against its `properties`, every array's items are
// walked, and the offending key is named by its JSON path (`nodes[3].deleted`) rather than dropped.
// An object the schema leaves open, and a value of a shape the schema does not describe, pass
// through untouched — the tool answers those itself, naming the type.
std::optional<std::string> undeclaredKey(const Json::Value& schema, const Json::Value& value,
                                         const std::string& path) {
  if (value.isObject()) {
    const Json::Value& properties = schema["properties"];
    const bool closed = schema["additionalProperties"].isBool() && !schema["additionalProperties"].asBool();
    for (const std::string& key : value.getMemberNames()) {
      const std::string here = path.empty() ? key : path + "." + key;
      if (!properties.isMember(key)) {
        if (!closed) continue;
        return "unknown argument \"" + here + "\". " + (path.empty() ? std::string("This tool") : path) +
               " takes: " + declaredKeys(schema) + ".";
      }
      if (std::optional<std::string> bad = undeclaredKey(properties[key], value[key], here)) return bad;
    }
    return std::nullopt;
  }
  if (value.isArray() && schema.isMember("items")) {
    for (Json::ArrayIndex i = 0; i < value.size(); ++i) {
      if (std::optional<std::string> bad =
              undeclaredKey(schema["items"], value[i], path + "[" + std::to_string(i) + "]"))
        return bad;
    }
  }
  return std::nullopt;
}

}  // namespace

std::optional<std::string> undeclaredArgument(const ToolDeclaration& tool, const Json::Value& arguments) {
  return undeclaredKey(tool.descriptor["inputSchema"], arguments, "");
}

}
