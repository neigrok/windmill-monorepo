#pragma once

#include "platform/domain/AiBudget.h"
#include <json/json.h>
#include <map>
#include <memory>
#include <optional>
#include <string>

struct evp_pkey_st;

namespace wm {

inline constexpr long long kAiPassLifetimeMs = 600'000;

struct AiPassRequest {
  std::string client;
  std::string use;
  int version;
  static std::optional<AiPassRequest> parse(std::string_view text);
};

class AiPasses {
public:
  AiPasses(const std::string& seed, std::string kid, std::string environment,
           const std::string& minimumVersions);
  ~AiPasses();
  AiPasses(const AiPasses&) = delete;
  AiPasses& operator=(const AiPasses&) = delete;
  std::string refusal(const AiPassRequest& request) const;
  Json::Value claims(const AiBudgetPrincipal& principal, const std::optional<std::string>& installation,
                     const std::string& client, long long now) const;
  std::string signPayload(const std::string& payload) const;
  std::string sign(const Json::Value& claims) const;

private:
  evp_pkey_st* key_ = nullptr;
  std::string kid_;
  std::string environment_;
  std::map<std::string, int> minimumVersions_;
};

}
