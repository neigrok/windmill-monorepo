#pragma once

#include "platform/application/AiBudgetService.h"
#include "platform/application/Heartbeat.h"
#include "platform/domain/Ids.h"
#include "platform/ports/Clock.h"
#include "platform/ports/TokenGenerator.h"

#include <memory>
#include <optional>
#include <string>
#include <string_view>

namespace wm {

enum class AiInstallationCode { Ok, Replay, Invalid, RateLimited, DeviceBound, Unavailable };
std::string_view aiInstallationCodeName(AiInstallationCode code);
bool validAiInstallationCredential(std::string_view value);
std::optional<std::string> aiInstallationNetworkAddress(const std::string& address);

struct AiInstallationPolicy {
  int issuesPerDay = 10;
  int generationsPerHour = 30;
  bool valid() const;
};

struct AiInstallationRow {
  std::string id;
  std::string tokenDigest;
  long long createdAtMs;
};

struct AiInstallationNetwork {
  std::string digest;
  long long expiresAtMs;
  int limit;
};

struct AiInstallationRepository {
  virtual ~AiInstallationRepository() = default;
  virtual std::optional<AiInstallationRow> find(const std::string& tokenDigest) = 0;
  virtual AiInstallationCode issue(const AiInstallationRow& row, const AiInstallationNetwork& network) = 0;
  virtual AiInstallationCode admit(const std::string& installationId, const std::string& requestId,
                                  const AiInstallationNetwork& network, long long atMs) = 0;
  virtual void prune(long long atMs) = 0;
};

class AiInstallationPrincipal {
public:
  const std::string& id() const { return id_; }
  const std::optional<std::string>& boundAccount() const { return boundAccount_; }

private:
  friend class AiInstallations;
  AiInstallationPrincipal(std::string id, std::optional<std::string> boundAccount)
      : id_(std::move(id)), boundAccount_(std::move(boundAccount)) {}
  std::string id_;
  std::optional<std::string> boundAccount_;
};

struct AiInstallationIssue {
  AiInstallationCode code = AiInstallationCode::Invalid;
  std::string credential;
  std::optional<AiInstallationPrincipal> principal;
};

class AiInstallations {
public:
  AiInstallations(AiInstallationRepository& repository, std::shared_ptr<AiBudgetService> budgets,
                  TokenGenerator& tokens, Clock& clock, std::optional<std::string> networkKey = std::nullopt,
                  AiInstallationPolicy policy = {});
  bool anonymousEnabled() const { return networkKey_.has_value(); }
  AiInstallationIssue issue(const std::string& canonicalIp);
  std::optional<AiInstallationPrincipal> authenticate(const std::string& credential);
  AiInstallationCode admitGeneration(const AiInstallationPrincipal& principal,
                                    const std::string& requestId, const std::string& canonicalIp);
  AiBudgetCode bind(const AiInstallationPrincipal& principal, const UserId& account);
  AiBudgetView allowance(const AiInstallationPrincipal& principal) const;
  void prune();
  void start() { heartbeat_.start(300, 3600, [this] { prune(); }); }
  void stop() { heartbeat_.stop(); }

private:
  AiInstallationNetwork network(const std::string& canonicalIp, long long atMs, bool issue) const;
  AiInstallationRepository& repository_;
  std::shared_ptr<AiBudgetService> budgets_;
  TokenGenerator& tokens_;
  Clock& clock_;
  std::optional<std::string> networkKey_;
  AiInstallationPolicy policy_;
  Heartbeat heartbeat_{"ai-installation-retention"};
};

}
