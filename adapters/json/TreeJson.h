#pragma once

#include "domain/Ids.h"
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

TreeData treeFromJson(const Json::Value& root, const TreeId& id);

std::string dump(const Json::Value& value);
Json::Value parse(const std::string& text);

}
