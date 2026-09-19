#pragma once

#include "products/gym/ports/AskThreadRepository.h"
#include <optional>
#include <string_view>

namespace wm::gym {

constexpr std::size_t kMaxCoachImageBytes = 5 * 1024 * 1024;
std::optional<CoachImage> decodeCoachImage(const std::string& id, const std::string& mediaType,
                                          std::string_view data);

}
