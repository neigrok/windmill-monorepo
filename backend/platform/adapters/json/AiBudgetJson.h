#pragma once

#include "platform/domain/AiBudget.h"
#include <json/value.h>

namespace wm {

Json::Value aiAllowanceJson(const AiBudgetView& allowance);
std::optional<AiBudgetView> aiAllowanceFromJson(const Json::Value& body);

}
