#pragma once

#include "platform/ports/SyncType.h"

#include <string_view>

namespace wm::journal::engine {

inline constexpr std::size_t kMaxPageBytes = 131'072;
inline constexpr sync::Ms kRevisionRetentionMs = 90 * 86'400'000ULL;

struct JournalOutcome {
  sync::CommandOutcome command;
  std::string claimId;
  Json::Value receipt;
  Json::Value contentClock;
};

struct JournalRevision {
  std::string day;
  Seq rev = 0;
  std::size_t bytes = 0;
  sync::Ms archivedAt = 0;
};

bool isCalendarDay(std::string_view);
bool isDocumentStamp(const Json::Value&);
int compareDocumentStamps(const Json::Value&, const Json::Value&);
Json::Value nextDocumentStamp(const Json::Value& pair, const Json::Value& observed,
                              sync::Ms now, const std::string& actor);
std::string claimBody(std::string_view account, std::string_view here);
JournalOutcome runJournal(const std::string& name, const Json::Value& args,
                           const Json::Value& rawArgs, const sync::Row* current,
                           const Json::Value& books, sync::Ms now);
std::vector<sync::Delta> checkJournal(const sync::Intent&);
std::vector<JournalRevision> pruneJournalRevisions(std::vector<JournalRevision>,
                                                  const std::set<std::string>& affected,
                                                  sync::Ms now);
Json::Value retainedRevisions(const Json::Value& input);

}
