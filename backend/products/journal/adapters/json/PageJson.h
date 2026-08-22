#pragma once

#include "products/journal/domain/Page.h"

#include <json/value.h>

#include <vector>

namespace wm {

// The wire boundary for a page. This is a cross-surface contract — web, iOS and Android all speak
// it — so it lives in one place and changes deliberately. Incoming carries the device's HLC stamp
// (the convergence key) and the day comes from the URL, not the body; outgoing is what every read
// returns.
//
//   in  : { "body": "...", "mood": 0..5, "energy": 0..3, "source": "typed"|"spoken", "stamp": "ms:ctr:actor" }
//   out : { "day": "YYYY-MM-DD", "body": "...", "mood": .., "energy": .., "source": .., "stamp": .., "updatedAt": ms }

Page parsePageWrite(const Json::Value& body, const UserId& user, const LocalDate& day);   // throws InvalidPage; PageTooLarge past kMaxPageBytes
Json::Value toJson(const Page& page);
Json::Value toJson(const std::vector<Page>& pages);

}
