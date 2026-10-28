#include "products/gym/coach/AbilityCatalog.h"

#include "platform/adapters/json/JsonText.h"
#include "products/gym/adapters/mcp/GymToolCatalog.h"

#include <cmath>
#include <regex>
#include <set>

namespace wm::gym::coach {

namespace {

struct AppendixRow {
  const char* name;
  AbilityClass cls;
  AgentRule agent;
  AbilitySeats seats;
  AbilityHost host = AbilityHost::phone;
};

// Appendix C with the build's rulings applied: R1 keeps every log ability withheld, R2 runs the
// shares on the server, R3 makes save_note a bound seat's ability.
constexpr AppendixRow kAppendixC[] = {
    {"list_routines", AbilityClass::read, AgentRule::runs, AbilitySeats::any},
    {"list_exercises", AbilityClass::read, AgentRule::runs, AbilitySeats::any},
    {"list_sessions", AbilityClass::read, AgentRule::runs, AbilitySeats::any},
    {"get_session", AbilityClass::read, AgentRule::runs, AbilitySeats::any},
    {"get_sessions", AbilityClass::read, AgentRule::runs, AbilitySeats::any},
    {"last_time", AbilityClass::read, AgentRule::runs, AbilitySeats::any},
    {"get_last_times", AbilityClass::read, AgentRule::runs, AbilitySeats::any},
    {"get_stats", AbilityClass::read, AgentRule::runs, AbilitySeats::any},
    {"get_record", AbilityClass::read, AgentRule::runs, AbilitySeats::any},
    {"list_notes", AbilityClass::read, AgentRule::runs, AbilitySeats::any},
    {"list_bodyweight", AbilityClass::read, AgentRule::runs, AbilitySeats::any},
    {"get_preferences", AbilityClass::read, AgentRule::runs, AbilitySeats::any},
    {"create_routine", AbilityClass::add, AgentRule::runs, AbilitySeats::any},
    {"create_exercise", AbilityClass::add, AgentRule::runs, AbilitySeats::any},
    {"save_note", AbilityClass::add, AgentRule::runs, AbilitySeats::bound},
    {"share_session", AbilityClass::add, AgentRule::runs, AbilitySeats::bound, AbilityHost::server},
    {"share_log", AbilityClass::add, AgentRule::runs, AbilitySeats::bound, AbilityHost::server},
    {"propose_routine_change", AbilityClass::change, AgentRule::proposes, AbilitySeats::any},
    {"propose_routine_removal", AbilityClass::remove, AgentRule::proposes, AbilitySeats::any},
    {"revoke_share", AbilityClass::remove, AgentRule::runs, AbilitySeats::bound, AbilityHost::server},
    {"start_session", AbilityClass::add, AgentRule::withheld, AbilitySeats::any},
    {"log_set", AbilityClass::add, AgentRule::withheld, AbilitySeats::any},
    {"log_sets", AbilityClass::add, AgentRule::withheld, AbilitySeats::any},
    {"import_session", AbilityClass::add, AgentRule::withheld, AbilitySeats::any},
    {"log_bodyweight", AbilityClass::add, AgentRule::withheld, AbilitySeats::any},
    {"finish_session", AbilityClass::change, AgentRule::withheld, AbilitySeats::any},
    {"fix_set", AbilityClass::change, AgentRule::withheld, AbilitySeats::any},
    {"correct_session", AbilityClass::change, AgentRule::withheld, AbilitySeats::any},
    {"update_exercise", AbilityClass::change, AgentRule::withheld, AbilitySeats::any},
    {"edit_note", AbilityClass::change, AgentRule::withheld, AbilitySeats::any},
    {"reorder_notes", AbilityClass::change, AgentRule::withheld, AbilitySeats::any},
    {"set_preferences", AbilityClass::change, AgentRule::withheld, AbilitySeats::any},
    {"delete_set", AbilityClass::remove, AgentRule::withheld, AbilitySeats::any},
    {"discard_session", AbilityClass::remove, AgentRule::withheld, AbilitySeats::any},
    {"delete_note", AbilityClass::remove, AgentRule::withheld, AbilitySeats::any},
    {"delete_bodyweight", AbilityClass::remove, AgentRule::withheld, AbilitySeats::any},
};

const AppendixRow* appendixRow(const std::string& name) {
  for (const AppendixRow& row : kAppendixC)
    if (name == row.name) return &row;
  return nullptr;
}

std::string typeOf(const Json::Value& value) {
  if (value.isNull()) return "null";
  if (value.isBool()) return "boolean";
  if (value.isString()) return "string";
  if (value.isArray()) return "array";
  if (value.isObject()) return "object";
  if (value.isIntegral()) return "integer";
  return "number";
}

bool typeAdmits(const std::string& declared, const Json::Value& value) {
  if (declared == "number") return value.isNumeric();
  if (declared == "integer") return value.isNumeric() && std::floor(value.asDouble()) == value.asDouble();
  return typeOf(value) == declared;
}

bool typeAllowed(const Json::Value& type, const Json::Value& value) {
  if (type.isString()) return typeAdmits(type.asString(), value);
  if (!type.isArray()) return true;
  for (const Json::Value& one : type)
    if (one.isString() && typeAdmits(one.asString(), value)) return true;
  return false;
}

std::string at(const std::string& path) { return path.empty() ? "the input" : path; }

std::string join(const std::string& path, const std::string& key) { return path.empty() ? key : path + "." + key; }

std::optional<std::string> violation(const Json::Value& schema, const Json::Value& value, const std::string& path) {
  if (!schema.isObject()) return std::nullopt;
  if (schema.isMember("type") && !typeAllowed(schema["type"], value))
    return at(path) + " must be " + dump(schema["type"]) + ", not " + typeOf(value);
  if (schema["enum"].isArray()) {
    bool listed = false;
    for (const Json::Value& allowed : schema["enum"]) listed = listed || allowed == value;
    if (!listed) return at(path) + " must be one of " + dump(schema["enum"]);
  }
  if (value.isString()) {
    const std::size_t length = value.asString().size();
    if (schema["minLength"].isNumeric() && length < schema["minLength"].asUInt64())
      return at(path) + " is shorter than " + dump(schema["minLength"]);
    if (schema["maxLength"].isNumeric() && length > schema["maxLength"].asUInt64())
      return at(path) + " is longer than " + dump(schema["maxLength"]);
    if (schema["pattern"].isString() && !std::regex_search(value.asString(), std::regex(schema["pattern"].asString())))
      return at(path) + " does not match " + schema["pattern"].asString();
  }
  if (value.isNumeric()) {
    const double number = value.asDouble();
    if (schema["minimum"].isNumeric() && number < schema["minimum"].asDouble())
      return at(path) + " is below " + dump(schema["minimum"]);
    if (schema["maximum"].isNumeric() && number > schema["maximum"].asDouble())
      return at(path) + " is above " + dump(schema["maximum"]);
    if (schema["multipleOf"].isNumeric() && schema["multipleOf"].asDouble() > 0) {
      const double quotient = number / schema["multipleOf"].asDouble();
      if (std::fabs(quotient - std::round(quotient)) > 1e-9) return at(path) + " is not a multiple of " + dump(schema["multipleOf"]);
    }
  }
  if (value.isArray()) {
    if (schema["minItems"].isNumeric() && value.size() < schema["minItems"].asUInt64())
      return at(path) + " holds fewer than " + dump(schema["minItems"]) + " items";
    if (schema["maxItems"].isNumeric() && value.size() > schema["maxItems"].asUInt64())
      return at(path) + " holds more than " + dump(schema["maxItems"]) + " items";
    if (schema["uniqueItems"].isBool() && schema["uniqueItems"].asBool()) {
      std::set<std::string> seen;
      for (const Json::Value& item : value)
        if (!seen.insert(dump(item)).second) return at(path) + " repeats an item";
    }
    if (schema.isMember("items"))
      for (Json::ArrayIndex index = 0; index < value.size(); ++index)
        if (const auto bad = violation(schema["items"], value[index], path + "[" + std::to_string(index) + "]")) return bad;
  }
  if (value.isObject()) {
    const Json::Value& properties = schema["properties"];
    const bool closed = schema["additionalProperties"].isBool() && !schema["additionalProperties"].asBool();
    for (const Json::Value& required : schema["required"])
      if (required.isString() && !value.isMember(required.asString()))
        return at(path) + " is missing " + required.asString();
    for (const std::string& key : value.getMemberNames()) {
      if (!properties.isMember(key)) {
        if (closed) return at(path) + " does not take " + key;
        continue;
      }
      if (const auto bad = violation(properties[key], value[key], join(path, key))) return bad;
    }
  }
  return std::nullopt;
}

}  // namespace

std::string_view nameOf(AbilityClass cls) {
  switch (cls) {
    case AbilityClass::read: return "read";
    case AbilityClass::add: return "add";
    case AbilityClass::change: return "change";
    case AbilityClass::remove: return "remove";
  }
  return "read";
}

std::string_view nameOf(AgentRule rule) {
  switch (rule) {
    case AgentRule::runs: return "runs";
    case AgentRule::proposes: return "proposes";
    case AgentRule::withheld: return "withheld";
  }
  return "withheld";
}

bool Ability::mintsId() const {
  if (host != AbilityHost::phone || agent == AgentRule::withheld) return false;
  if (cls != AbilityClass::add && agent != AgentRule::proposes) return false;
  return declaration.descriptor["inputSchema"]["properties"].isMember("id");
}

AbilityCatalog AbilityCatalog::of(const std::vector<ToolDeclaration>& declarations) {
  AbilityCatalog catalog;
  for (const ToolDeclaration& declaration : declarations) {
    Ability ability{declaration};
    if (const AppendixRow* row = appendixRow(declaration.name())) {
      ability.cls = row->cls;
      ability.agent = row->agent;
      ability.seats = row->seats;
      ability.host = row->host;
    }
    catalog.abilities_.push_back(std::move(ability));
  }
  return catalog;
}

const Ability* AbilityCatalog::find(std::string_view name) const {
  for (const Ability& ability : abilities_)
    if (ability.name() == name) return &ability;
  return nullptr;
}

std::vector<ToolDeclaration> AbilityCatalog::offered(Seat seat) const {
  std::vector<ToolDeclaration> out;
  for (const Ability& ability : abilities_) {
    if (ability.agent == AgentRule::withheld) continue;
    if (ability.seats == AbilitySeats::bound && seat != Seat::bound) continue;
    out.push_back(ability.declaration);
  }
  return out;
}

const AbilityCatalog& gymAbilityCatalog() {
  static const AbilityCatalog catalog = AbilityCatalog::of(gymToolCatalog());
  return catalog;
}

std::optional<std::string> schemaViolation(const Json::Value& schema, const Json::Value& value) {
  return violation(schema, value, "");
}

}
