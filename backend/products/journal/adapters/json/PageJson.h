#pragma once

#include "products/journal/domain/Page.h"

#include <json/value.h>

#include <vector>

namespace wm {

// The page as the journal's REST reads answer it:
//
//   out : { "day": "YYYY-MM-DD", "body": "...", "mood": .., "energy": .., "source": .., "stamp": .., "updatedAt": ms }
//
// Both scales are null when unanswered and 0 when the writer answered zero.

Json::Value toJson(const Page& page);
Json::Value toJson(const std::vector<Page>& pages);

}
