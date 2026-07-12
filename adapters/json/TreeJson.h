#pragma once

#include "domain/GraphState.h"
#include "domain/Ids.h"
#include "domain/Legend.h"
#include "domain/Tree.h"
#include "domain/TreeDiagnostics.h"

#include <json/json.h>

#include <string>

namespace wm {

// The JSON boundary: converts domain types to and from the wire/persist shape. This is
// the only place the domain meets a serialization format.
Json::Value toJson(const TreeData& data);
Json::Value toJson(const Progress& progress);
Json::Value toJson(const TreeDiagnostics& diagnostics);
Json::Value toJson(const GraphState& state);    // the persisted graph document
Json::Value toJson(const LegendState& legend);  // the persisted legend document

TreeData treeFromJson(const Json::Value& root, const TreeId& id);
GraphState graphStateFromJson(const Json::Value& root);
LegendState legendStateFromJson(const Json::Value& kinds);

std::string dump(const Json::Value& value);
Json::Value parse(const std::string& text);

}
