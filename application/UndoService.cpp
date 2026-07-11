#include "application/UndoService.h"

namespace wm {

void UndoService::record(const UserId& user, std::vector<Command> inverse) {
  if (inverse.empty()) return;
  stacks_[user].push_back(std::move(inverse));
}

std::optional<std::vector<Command>> UndoService::pop(const UserId& user) {
  auto it = stacks_.find(user);
  if (it == stacks_.end() || it->second.empty()) return std::nullopt;
  std::vector<Command> top = std::move(it->second.back());
  it->second.pop_back();
  return top;
}

std::size_t UndoService::depth(const UserId& user) const {
  auto it = stacks_.find(user);
  return it == stacks_.end() ? 0 : it->second.size();
}

}
