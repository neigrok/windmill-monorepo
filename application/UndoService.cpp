#include "application/UndoService.h"

namespace wm {

namespace {
std::optional<std::vector<Command>> takeTop(std::map<std::string, std::vector<std::vector<Command>>>& stacks,
                                            const std::string& key) {
  auto it = stacks.find(key);
  if (it == stacks.end() || it->second.empty()) return std::nullopt;
  std::vector<Command> top = std::move(it->second.back());
  it->second.pop_back();
  return top;
}
}

void UndoService::record(const std::string& key, std::vector<Command> inverse) {
  if (inverse.empty()) return;
  std::lock_guard<std::mutex> lock(mutex_);
  undo_[key].push_back(std::move(inverse));
  redo_[key].clear();  // a fresh edit invalidates the redo trail
}

std::optional<std::vector<Command>> UndoService::takeUndo(const std::string& key) {
  std::lock_guard<std::mutex> lock(mutex_);
  return takeTop(undo_, key);
}

std::optional<std::vector<Command>> UndoService::takeRedo(const std::string& key) {
  std::lock_guard<std::mutex> lock(mutex_);
  return takeTop(redo_, key);
}

void UndoService::pushUndo(const std::string& key, std::vector<Command> group) {
  if (group.empty()) return;
  std::lock_guard<std::mutex> lock(mutex_);
  undo_[key].push_back(std::move(group));
}

void UndoService::pushRedo(const std::string& key, std::vector<Command> group) {
  if (group.empty()) return;
  std::lock_guard<std::mutex> lock(mutex_);
  redo_[key].push_back(std::move(group));
}

}
