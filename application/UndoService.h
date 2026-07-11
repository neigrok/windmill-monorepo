#pragma once

#include "domain/Command.h"

#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

namespace wm {

// Per-key undo/redo stacks of inverse-command groups. The key is opaque (the caller
// uses tree + actor). A fresh edit records its inverse and clears redo; undo takes the
// top inverse group to replay, and the caller hands back the resulting counter-inverse
// so redo can replay it — collaborative undo is just more ops (§5).
class UndoService {
public:
  void record(const std::string& key, std::vector<Command> inverse);
  std::optional<std::vector<Command>> takeUndo(const std::string& key);
  std::optional<std::vector<Command>> takeRedo(const std::string& key);
  void pushUndo(const std::string& key, std::vector<Command> group);
  void pushRedo(const std::string& key, std::vector<Command> group);

private:
  mutable std::mutex mutex_;
  std::map<std::string, std::vector<std::vector<Command>>> undo_;
  std::map<std::string, std::vector<std::vector<Command>>> redo_;
};

}
