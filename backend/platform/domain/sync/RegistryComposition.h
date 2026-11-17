#pragma once

#include "platform/domain/sync/Registry.h"

namespace wm::sync {

Json::Value composeRegistry(const Json::Value& manifest, const std::map<std::string, Json::Value>& documents);

}
