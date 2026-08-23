#pragma once

#include "products/roadmap/domain/Command.h"

#include <json/json.h>

#include <optional>
#include <string>

namespace wm {

std::optional<Command> commandFromJson(const std::string& kind, const Json::Value& payload);
Json::Value commandPayload(const Command& command);
std::string commandKind(const Command& command);

}
