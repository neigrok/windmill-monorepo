#pragma once

#include "products/gym/domain/Statistics.h"
#include "products/gym/domain/Training.h"

#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

struct HistoryQuery {
  std::uint64_t fromMs = 0;
  std::uint64_t untilMs = kMaxInstantMs;
  std::string exercise;
  std::string routine;
  std::string timeZone = "UTC";
  std::uint64_t beforeMs = kMaxInstantMs;
  std::string beforeId;
  int limit = 50;
  bool includeProgress = false;
  std::uint64_t asOfMs = 0;

  void validate() const;
};

struct HistorySet {
  std::string id;
  std::string exerciseId;
  std::string exercise;
  int setNumber;
  double weightKg;
  int reps;
  std::optional<double> rpe;
  std::uint64_t completedAtMs;
  bool working;
};

struct HistoryTotals {
  int sessions = 0;
  int sets = 0;
  int reps = 0;
  double tonnageKg = 0;
};

struct HistoryWorkout {
  std::string id;
  std::uint64_t startedAtMs;
  std::uint64_t finishedAtMs;
  std::string routineId;
  std::string routineName;
  std::vector<HistorySet> sets;

  HistoryTotals totals(const std::optional<std::string>& exercise = std::nullopt) const;
};

struct HistoryFacet {
  std::string id;
  std::string name;
  int sessions;
  std::string equipment;
};

struct HistoryMonth {
  std::string month;
  int sessions;
};

struct HistoryPage {
  std::vector<HistoryWorkout> sessions;
  HistoryTotals summary;
  std::vector<HistoryMonth> months;
  std::vector<HistoryFacet> exercises;
  std::vector<HistoryFacet> routines;
  bool hasMore = false;
  std::optional<StatsProgress> progress;
};

enum class LogShareMode { snapshot, live };

struct LogShare {
  std::string id;
  UserId user;
  std::string token;
  LogShareMode mode;
  bool range;
  std::uint64_t fromMs;
  std::uint64_t untilMs;
  std::uint64_t createdAtMs;
  std::uint64_t expiresAtMs;

  void validate() const;
  bool sameRequest(const LogShare& other) const;
  HistoryQuery constrain(HistoryQuery query) const;
};

struct SharedHistory {
  LogShare share;
  HistoryPage page;
};

}
