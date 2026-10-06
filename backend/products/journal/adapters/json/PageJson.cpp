#include "products/journal/adapters/json/PageJson.h"

namespace wm {

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
