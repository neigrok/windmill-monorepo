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

// Keys are "<treeId>\n<actor>"; a closing connection's actor is unique, so erasing every
// key ending in "\n<actor>" reclaims its undo/redo across whatever trees it touched.
void UndoService::forgetActor(const std::string& actor) {
  const std::string suffix = "\n" + actor;
  std::lock_guard<std::mutex> lock(mutex_);
  for (std::map<std::string, std::vector<std::vector<Command>>>* stacks : {&undo_, &redo_}) {
    for (auto it = stacks->begin(); it != stacks->end();) {
      const std::string& key = it->first;
      if (key.size() >= suffix.size() && key.compare(key.size() - suffix.size(), suffix.size(), suffix) == 0)
        it = stacks->erase(it);
      else
        ++it;
    }
  }
}

}
