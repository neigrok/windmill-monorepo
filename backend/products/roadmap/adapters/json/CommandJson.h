#pragma once

#include "products/roadmap/domain/Command.h"

#include <json/json.h>

#include <optional>
#include <string>

namespace wm {

// The command boundary: parse an inbound cmd frame's (kind, payload) into a domain
// Command, and render a command's kind/payload for the op log.
std::optional<Command> commandFromJson(const std::string& kind, const Json::Value& payload);
Json::Value commandPayload(const Command& command);
std::string commandKind(const Command& command);

}
