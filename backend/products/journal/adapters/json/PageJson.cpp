#include "products/journal/adapters/json/PageJson.h"

#include <string>

namespace wm {

Page parsePageWrite(const Json::Value& body, const UserId& user, const LocalDate& day) {
  if (!body.isObject()) throw InvalidPage{"a page write must be a json object"};
  Page page{user, day};
  page.body = body.get("body", "").asString();
  // The one door a client's words come through, so the length rule is stated here and nowhere else:
  // every surface (web, iOS, Android) parses a page write with this function, and a cap enforced in
  // a handler would be a cap the next handler forgets. Past it the write never becomes a Page, so it
  // can never become a row — nor a body trailed into the revision table by the write after it.
  if (page.body.size() > kMaxPageBytes)
    throw PageTooLarge{"a page may carry " + std::to_string(kMaxPageBytes) + " bytes"};
  page.mood = moodFromInt(body.get("mood", 0).asInt());
  page.energy = energyFromInt(body.get("energy", 0).asInt());
  page.source = parseSource(body.get("source", "typed").asString());
  page.stamp = parseHlc(body.get("stamp", "0:0:").asString());
  // updatedAtMs stays 0: it is server time, stamped on store — a client can never carry it in.
  return page;
}

Json::Value toJson(const Page& page) {
  Json::Value body(Json::objectValue);
  body["day"] = page.day.iso();
  body["body"] = page.body;
  body["mood"] = toInt(page.mood);
  body["energy"] = toInt(page.energy);
  body["source"] = toString(page.source);
  // The stamp codec is shared with the op log and the subgraph wire (domain/Ids.h): the
  // document and the wire speak one stamp format.
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
