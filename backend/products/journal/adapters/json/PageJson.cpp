#include "products/journal/adapters/json/PageJson.h"

#include <optional>
#include <string>

namespace wm {

Page parsePageWrite(const Json::Value& body, const UserId& user, const LocalDate& day) {
  if (!body.isObject()) throw InvalidPage{"a page write must be a json object"};
  Page page{user, day};
  page.body = body.get("body", "").asString();
  // Every surface parses a page write here, so the length rule is stated here and nowhere else.
  if (page.body.size() > kMaxPageBytes)
    throw PageTooLarge{"a page may carry " + std::to_string(kMaxPageBytes) + " bytes"};
  // Absent, null, non-int or out of 0..10 all read as unanswered — narrow, never reject.
  auto score = [&body](const char* field) -> std::optional<Score> {
    const Json::Value& value = body[field];
    if (!value.isInt()) return std::nullopt;
    return Score::from(value.asInt());
  };
  page.mood = score("mood");
  page.energy = score("energy");
  page.source = parseSource(body.get("source", "typed").asString());
  page.stamp = parseHlc(body.get("stamp", "0:0:").asString());
  // updatedAtMs stays 0: it is server time, stamped on store.
  return page;
}

Json::Value toJson(const Page& page) {
  Json::Value body(Json::objectValue);
  body["day"] = page.day.iso();
  body["body"] = page.body;
  body["mood"] = page.mood ? Json::Value(page.mood->value()) : Json::Value(Json::nullValue);
  body["energy"] = page.energy ? Json::Value(page.energy->value()) : Json::Value(Json::nullValue);
  body["source"] = toString(page.source);
  body["stamp"] = toString(page.stamp);
  body["updatedAt"] = Json::Value::UInt64(page.updatedAtMs);
  return body;
}

Json::Value toJson(const std::vector<Page>& pages) {
  Json::Value array(Json::arrayValue);
  for (const Page& page : pages) array.append(toJson(page));
  return array;
}

}
