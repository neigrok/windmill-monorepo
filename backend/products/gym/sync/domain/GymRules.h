#pragma once

#include "platform/ports/SyncType.h"

namespace wm::gym::engine {

inline constexpr sync::Ms kStaleMs = 4 * 3'600'000;

struct GymFacts {
  std::vector<sync::Row> rows;
  std::map<std::pair<std::string, std::string>, sync::Locked> locked;
  Json::Value books = Json::Value(Json::objectValue);

  const sync::Row* row(const std::string& type, const std::string& id) const;
  sync::IdState::Kind identity(const std::string& type, const std::string& id) const;
};

struct GymOutcome {
  sync::CommandOutcome command;
  std::string receiptKind;
  std::string receiptId;
  Json::Value receipt;
};

Json::Value value(const sync::Row* row, const std::string& field);
bool open(const sync::Row& session);
sync::Ms lastActivity(const GymFacts& facts, const sync::Row& session);
std::vector<sync::Delta> checkGym(const GymFacts& facts, const std::vector<sync::Change>& changes,
                                  const sync::Intent& intent, bool server, sync::Ms now);
GymOutcome runGym(const std::string& name, const Json::Value& args, const Json::Value& rawArgs,
                  const GymFacts& facts, sync::Ms now);
int proposalChangeCount(const Json::Value& base, const Json::Value& changes, const Json::Value& baseName, const Json::Value& proposedName);
void projectGym(Json::Value& books, const sync::RowWrite& write);

}
