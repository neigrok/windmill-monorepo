#pragma once

#include <json/json.h>

#include <vector>

namespace wm {

// The two published vocabularies, shared by the schemas that advertise them and the checks that
// refuse against them — a legal set stated in one place cannot drift from the one enforced.
inline const std::vector<const char*> kHues = {"terracotta", "olive", "gold", "brick", "sky", "plum"};
inline const std::vector<const char*> kStatuses = {"active", "complete", "none"};

// What this server advertises to an agent: every tool, its description, and the JSON Schema its
// arguments are pre-validated against. It is the whole published contract and nothing else — no
// registry, no room, no caller — so what an agent is promised can be read in one file, apart from
// the dispatch that keeps the promise (RoadmapTools.cpp). Byte-pinned by the wire corpus test.
Json::Value roadmapToolCatalog();

}
