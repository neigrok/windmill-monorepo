#pragma once

#include "domain/Command.h"
#include "ports/Op.h"

#include <json/json.h>

#include <optional>
#include <string>

namespace wm {

// The command boundary: parse an inbound cmd frame's (kind, payload) into a domain
// Command, and render an accepted op back out as an "op" frame.
std::optional<Command> commandFromJson(const std::string& kind, const Json::Value& payload);
Json::Value commandPayload(const Command& command);
std::string commandKind(const Command& command);
Json::Value opFrame(const AppliedOp& op);

}
