#pragma once

#include "products/journal/domain/Page.h"

#include <json/value.h>

#include <vector>

namespace wm {

// The wire shape web, iOS and Android all speak. Incoming carries the device's HLC stamp; the day
// comes from the URL, not the body.
//
//   in  : { "body": "...", "mood": 0..5, "energy": 0..3, "source": "typed"|"spoken", "stamp": "ms:ctr:actor" }
//   out : { "day": "YYYY-MM-DD", "body": "...", "mood": .., "energy": .., "source": .., "stamp": .., "updatedAt": ms }

Page parsePageWrite(const Json::Value& body, const UserId& user, const LocalDate& day);   // throws InvalidPage; PageTooLarge past kMaxPageBytes
Json::Value toJson(const Page& page);
Json::Value toJson(const std::vector<Page>& pages);

}
