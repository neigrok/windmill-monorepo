#pragma once

#include "products/journal/adapters/json/PageJson.h"

namespace wm::journal::engine {

inline Json::Value savePageIntent(const Json::Value& raw, const UserId& user, const LocalDate& day) {
  const Page page = parsePageWrite(raw, user, day);
  Json::Value intent(Json::objectValue);
  intent["scope"] = "self/journal";
  intent["d"] = Json::Value(Json::arrayValue);
  intent["cmd"]["name"] = "journal.savePage";
  auto& args = intent["cmd"]["args"];
  args["day"] = page.day.iso();
  args["body"] = page.body;
  args["mood"] = page.mood ? Json::Value(page.mood->value()) : Json::Value();
  args["energy"] = page.energy ? Json::Value(page.energy->value()) : Json::Value();
  args["source"] = wm::toString(page.source);
  args["stamp"]["ms"] = Json::UInt64(page.stamp.physicalMs);
  args["stamp"]["counter"] = Json::UInt(page.stamp.counter);
  args["stamp"]["actor"] = page.stamp.actor;
  return intent;
}

}
