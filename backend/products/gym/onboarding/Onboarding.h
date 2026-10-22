#pragma once

#include "products/gym/domain/Routine.h"

#include <json/json.h>

#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

constexpr std::size_t kOnboardingImageBytes = 1024 * 1024;
constexpr long long kOnboardingLeaseMs = 15 * 60 * 1000;
constexpr long long kOnboardingRetentionMs = 7 * 24 * 60 * 60 * 1000LL;
constexpr std::size_t kOnboardingMessageBytes = 4000;

struct OnboardingIn {
  std::string requestId;
  std::string mode;
  std::string goal;
  int daysPerWeek = 0;
  std::string equipment;
  std::string program;
  std::string note;
  std::string imageMimeType;
  std::string imageBase64;
  std::string text;
  Json::Value context{Json::arrayValue};
};

struct OnboardingRoutine {
  std::string name;
  std::vector<RoutineEntry> entries;
  bool operator==(const OnboardingRoutine&) const = default;
};

// A conversation reply as the lifter reads it: the model's whole message, or the words that fit the byte
// bound followed by an ellipsis.
struct OnboardingMessage {
  std::string text;
  bool clipped = false;
};

struct OnboardingRecord {
  std::string deviceId;
  std::string requestId;
  std::string inputHash;
  std::string resultId;
  std::string state = "pending";
  Json::Value payload;
  std::string errorCode;
  long long createdAtMs = 0;
  long long leaseUntilMs = 0;
  long long expiresAtMs = 0;
  long long terminalAtMs = 0;
};

struct OnboardingClaim {
  std::optional<OnboardingRecord> record;
  bool created = false;
  std::string refusal;
};

struct OnboardingRepository {
  virtual ~OnboardingRepository() = default;
  virtual OnboardingClaim claim(const OnboardingRecord& proposed) = 0;
  virtual std::optional<OnboardingRecord> get(const std::string& deviceId,
                                            const std::string& requestId, long long nowMs) = 0;
  virtual bool finish(const OnboardingRecord& result, long long nowMs) = 0;
  virtual void expire(long long nowMs) = 0;
};

bool validOnboardingRequestId(const std::string& id);
std::optional<OnboardingIn> readOnboardingIn(const Json::Value& body);
Json::Value onboardingInput(const OnboardingIn& input);
std::optional<std::vector<OnboardingRoutine>> readOnboardingRoutines(
    const Json::Value& output, const OnboardingIn& input, const std::vector<Exercise>& seeds);
Json::Value onboardingRoutines(const std::vector<OnboardingRoutine>& routines);
OnboardingMessage onboardingMessage(const std::string& said);
OnboardingRecord expireOnboarding(OnboardingRecord record, long long nowMs);

}
