#pragma once

#include "platform/application/sync/SyncCatalog.h"

#include <memory>
#include <string_view>

namespace wm::sync {

std::string_view compositionText();
const Registry& productRegistry();
std::shared_ptr<SyncCatalog> productCatalog();

}
