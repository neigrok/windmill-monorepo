#pragma once

#include "platform/adapters/json/JsonText.h"
#include "platform/ports/ToolHost.h"
#include "test/testing.h"

#include <json/json.h>

#include <set>
#include <string>
#include <vector>

namespace wm::test {

// Where `value` breaks `schema`, one line each, path first, as a client that validates structuredContent finds it. It
// reads the subset of JSON Schema the tool catalogs declare; any other keyword is a line of its own, so a schema this
// cannot check never passes as one it did.
inline std::vector<std::string> schemaViolations(const Json::Value& schema, const Json::Value& value,
                                                 const std::string& path = "$") {
  static const std::set<std::string> kRead = {"type",      "description", "enum",     "properties", "required",
                                              "additionalProperties",     "items",    "minItems",   "maxItems",
                                              "uniqueItems", "minLength", "maxLength", "minimum",   "maximum",
                                              "default",   "deprecated"};
  std::vector<std::string> broken;
  for (const std::string& keyword : schema.getMemberNames())
    if (!kRead.count(keyword)) broken.push_back(path + ": the schema says `" + keyword + "`, which this check cannot read");

  const auto isType = [&](const std::string& type) {
    if (type == "object") return value.isObject();
    if (type == "array") return value.isArray();
    if (type == "string") return value.isString();
    if (type == "boolean") return value.isBool();
    if (type == "null") return value.isNull();
    if (type == "number") return value.isNumeric() && !value.isBool();
    if (type == "integer") return value.isIntegral() && !value.isBool();
    return false;
  };
  if (schema.isMember("type")) {
    bool matched = false;
    if (schema["type"].isArray()) {
      for (const Json::Value& type : schema["type"]) matched = matched || isType(type.asString());
    } else {
      matched = isType(schema["type"].asString());
    }
    if (!matched) {
      broken.push_back(path + ": is " + dump(value) + ", not of type " + dump(schema["type"]));
      return broken;
    }
  }
  if (schema.isMember("enum")) {
    bool listed = false;
    for (const Json::Value& allowed : schema["enum"]) listed = listed || allowed == value;
    if (!listed) broken.push_back(path + ": " + dump(value) + " is not one of " + dump(schema["enum"]));
  }

  if (value.isObject()) {
    for (const Json::Value& field : schema["required"])
      if (!value.isMember(field.asString())) broken.push_back(path + ": lacks the required `" + field.asString() + "`");
    const Json::Value& properties = schema["properties"];
    for (const std::string& key : value.getMemberNames()) {
      if (properties.isMember(key)) {
        for (const std::string& line : schemaViolations(properties[key], value[key], path + "." + key))
          broken.push_back(line);
      } else if (schema.isMember("additionalProperties") && !schema["additionalProperties"].asBool()) {
        broken.push_back(path + ": carries `" + key + "`, which the schema does not declare");
      }
    }
  }
  if (value.isArray()) {
    if (schema.isMember("minItems") && value.size() < schema["minItems"].asUInt())
      broken.push_back(path + ": holds " + std::to_string(value.size()) + " items, under minItems");
    if (schema.isMember("maxItems") && value.size() > schema["maxItems"].asUInt())
      broken.push_back(path + ": holds " + std::to_string(value.size()) + " items, over maxItems");
    if (schema.get("uniqueItems", false).asBool())
      for (Json::ArrayIndex i = 0; i < value.size(); ++i)
        for (Json::ArrayIndex j = i + 1; j < value.size(); ++j)
          if (value[i] == value[j]) broken.push_back(path + ": repeats " + dump(value[i]) + " under uniqueItems");
    if (schema.isMember("items"))
      for (Json::ArrayIndex i = 0; i < value.size(); ++i)
        for (const std::string& line : schemaViolations(schema["items"], value[i], path + "[" + std::to_string(i) + "]"))
          broken.push_back(line);
  }
  if (value.isString()) {
    std::size_t characters = 0;
    for (unsigned char byte : value.asString()) characters += (byte & 0xC0) != 0x80;
    if (schema.isMember("minLength") && characters < schema["minLength"].asUInt())
      broken.push_back(path + ": is " + std::to_string(characters) + " characters, under minLength");
    if (schema.isMember("maxLength") && characters > schema["maxLength"].asUInt())
      broken.push_back(path + ": is " + std::to_string(characters) + " characters, over maxLength");
  }
  if (value.isNumeric() && !value.isBool()) {
    if (schema.isMember("minimum") && value.asDouble() < schema["minimum"].asDouble())
      broken.push_back(path + ": " + dump(value) + " is under the minimum");
    if (schema.isMember("maximum") && value.asDouble() > schema["maximum"].asDouble())
      broken.push_back(path + ": " + dump(value) + " is over the maximum");
  }
  return broken;
}

// A result as an MCP client takes it: a tool that publishes an outputSchema answers every success with structuredContent
// that schema accepts, and one that publishes none answers with none. Each break is a failure naming the tool.
inline void checkStructuredContent(const ToolHost& host, const std::string& tool, const ToolResult& result,
                                   const char* file, int line) {
  Json::Value schema(Json::nullValue);
  for (const ToolDeclaration& declaration : host.declareTools())
    if (declaration.name() == tool) schema = declaration.descriptor["outputSchema"];
  std::vector<std::string> broken;
  if (schema.isNull() && !result.structured.isNull()) broken.push_back("$: structuredContent with no outputSchema");
  if (!schema.isNull() && !result.isError) {
    if (result.structured.isNull()) broken.push_back("$: no structuredContent beside its outputSchema");
    else broken = schemaViolations(schema, result.structured);
  }
  for (const std::string& lineOf : broken) {
    const std::string said = tool + " structuredContent " + lineOf;
    ::testing::fail(said.c_str(), file, line);
  }
}

}
