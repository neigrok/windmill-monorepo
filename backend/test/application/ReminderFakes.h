#pragma once

#include "ports/ReminderRepository.h"

#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

namespace wm::fake {

// The reminder database as a script. It records what was asked of it in the order it was asked,
// which is the whole point: DECIDE → CLAIM → SEND is an ordering guarantee, so a test asserts the
// order as well as the outcome. Shared by the sweep's tests and the HTTP surface's, because they
// are two edges onto exactly one set of rows.
struct FakeReminders : ReminderRepository {
  struct Claim {
    UserId user;
    std::string slotDate;
    ReminderDecision decision;
  };
  struct Close {
    UserId user;
    std::string slotDate;
    WeekOutcome outcome;
  };

  bool lockFree = true;
  int locksTaken = 0;
  int locksReleased = 0;
  int askedLimit = 0;
  std::vector<DueUser> due;
  std::map<std::string, std::vector<TreeReadiness>> readiness;
  std::map<std::string, std::uint64_t> lastActive;
  std::map<std::string, std::uint64_t> born;
  std::set<std::string> weeksOwnedElsewhere;  // users whose claim must lose the race
  std::set<std::string> unreadable;           // users whose load throws
  std::vector<Claim> claims;
  std::vector<Close> closes;
  std::map<std::string, std::string> pauseDigests;
  std::map<std::string, ReminderSettings> settings;
  std::set<std::string> unknownTimezones;  // names Postgres would refuse

  bool tryLockSweep() override {
    if (!lockFree) return false;
    ++locksTaken;
    return true;
  }
  void unlockSweep() override { ++locksReleased; }

  std::vector<DueUser> dueNow(std::uint64_t, int limit) override {
    askedLimit = limit;
    return due;
  }
  std::vector<TreeReadiness> readinessFor(const UserId& user) override {
    if (unreadable.count(user.str())) throw std::runtime_error("tree_nodes is on fire");
    return readiness[user.str()];
  }
  std::uint64_t lastActiveAtMs(const UserId& user) override { return lastActive[user.str()]; }
  std::uint64_t accountCreatedAtMs(const UserId& user) override { return born[user.str()]; }

  bool claimWeek(const UserId& user, const std::string& slotDate,
                 const ReminderDecision& decision) override {
    claims.push_back(Claim{user, slotDate, decision});
    return weeksOwnedElsewhere.count(user.str()) == 0;
  }
  void closeWeek(const UserId& user, const std::string& slotDate, WeekOutcome outcome) override {
    closes.push_back(Close{user, slotDate, outcome});
  }

  std::optional<ReminderSettings> settingsFor(const UserId& user) override {
    auto it = settings.find(user.str());
    if (it == settings.end()) return std::nullopt;
    return it->second;
  }
  bool upsertSettings(const UserId& user, bool enabled, const std::string& ianaTz) override {
    if (unknownTimezones.count(ianaTz)) return false;
    ReminderSettings& row = settings[user.str()];
    row.enabled = enabled;
    row.timezone = ianaTz;
    return true;
  }

  void setPauseDigest(const UserId& user, const std::string& digest) override {
    pauseDigests[user.str()] = digest;
  }
  std::optional<UserId> userByPauseDigest(const std::string& digest) override {
    if (digest.empty()) return std::nullopt;
    for (const auto& [user, stored] : pauseDigests)
      if (stored == digest) return UserId{user};
    return std::nullopt;
  }
  void pause(const UserId& user) override {
    settings[user.str()].enabled = false;
    pauseDigests.erase(user.str());  // the link is spent the moment it is used
  }
};

}
