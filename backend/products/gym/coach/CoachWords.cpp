#include "products/gym/coach/CoachWords.h"

#include "platform/adapters/json/JsonText.h"

#include <json/json.h>

#include <optional>
#include <stdexcept>

namespace wm::gym::coach {

// Embedded by CMake from packages/api-contract/gym/coach (wm_embed_registry).
std::string_view coachPromptText();
std::string_view coachFirstContentText();
std::string_view coachRefusalsText();

namespace {

Json::Value object(std::string_view json, const char* file) {
  const std::optional<Json::Value> parsed = parseWhole(std::string(json));
  if (!parsed || !parsed->isObject()) throw std::invalid_argument(std::string(file) + " is not a JSON object");
  return *parsed;
}

std::string text(const Json::Value& value, const char* where) {
  if (!value.isString() || value.asString().empty()) throw std::invalid_argument(std::string(where) + " is not a sentence");
  return value.asString();
}

std::map<std::string, std::string> sentences(const Json::Value& value, const char* where) {
  if (!value.isObject() || value.empty()) throw std::invalid_argument(std::string(where) + " holds no sentences");
  std::map<std::string, std::string> out;
  for (const std::string& key : value.getMemberNames()) out[key] = text(value[key], where);
  return out;
}

}  // namespace

CoachWords::CoachWords(std::string_view prompt, std::string_view firstContent, std::string_view refusals) : prompt_(prompt) {
  if (prompt_.empty()) throw std::invalid_argument("prompt.md is empty");
  const Json::Value first = object(firstContent, "first-content.json");
  contextLeads_ = sentences(first["contextLeads"], "first-content.json contextLeads");
  const Json::Value& earlier = first["earlierConversation"];
  earlierMarker_ = text(earlier["marker"], "first-content.json earlierConversation.marker");
  lifter_ = text(earlier["lifter"], "first-content.json earlierConversation.lifter");
  coach_ = text(earlier["coach"], "first-content.json earlierConversation.coach");
  pictureOnlyQuestion_ = text(first["pictureOnlyQuestion"], "first-content.json pictureOnlyQuestion");
  refusals_ = sentences(object(refusals, "refusals.json"), "refusals.json");
}

const CoachWords& CoachWords::shipped() {
  static const CoachWords words(coachPromptText(), coachFirstContentText(), coachRefusalsText());
  return words;
}

std::string CoachWords::refusal(const std::string& code, std::string_view target) const {
  std::string sentence = refusals_.at(code);
  constexpr std::string_view slot = "{target}";
  if (const auto at = sentence.find(slot); at != std::string::npos) sentence.replace(at, slot.size(), target);
  return sentence;
}

}
