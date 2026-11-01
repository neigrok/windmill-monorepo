#include "platform/ai_installations/AiInstallations.h"

#include "platform/application/WriteObservation.h"

#include <openssl/hmac.h>
#include <arpa/inet.h>
#include <algorithm>
#include <array>
#include <stdexcept>

namespace wm {

std::string_view aiInstallationCodeName(AiInstallationCode code) {
  switch (code) {
    case AiInstallationCode::Ok: return "ok";
    case AiInstallationCode::Replay: return "replay";
    case AiInstallationCode::Invalid: return "invalid_installation";
    case AiInstallationCode::RateLimited: return "installation_rate_limited";
    case AiInstallationCode::DeviceBound: return "installation_bound";
    case AiInstallationCode::Unavailable: return "anonymous_ai_unavailable";
  }
  return "invalid_installation";
}

bool validAiInstallationCredential(std::string_view value) {
  return value.size() == 43 && std::all_of(value.begin(), value.end(), [](unsigned char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
  });
}

std::optional<std::string> aiInstallationNetworkAddress(const std::string& address) {
  if (address.empty() || address.size() > INET6_ADDRSTRLEN || address.find('\0') != std::string::npos ||
      address.find('%') != std::string::npos) return std::nullopt;
  std::array<char, INET6_ADDRSTRLEN> canonical{};
  in_addr ipv4{};
  if (inet_pton(AF_INET, address.c_str(), &ipv4) == 1) {
    if (!inet_ntop(AF_INET, &ipv4, canonical.data(), canonical.size())) return std::nullopt;
    return std::string(canonical.data());
  }
  in6_addr ipv6{};
  if (inet_pton(AF_INET6, address.c_str(), &ipv6) != 1) return std::nullopt;
  if (IN6_IS_ADDR_V4MAPPED(&ipv6)) {
    if (!inet_ntop(AF_INET, &ipv6.s6_addr[12], canonical.data(), canonical.size())) return std::nullopt;
    return std::string(canonical.data());
  }
  std::fill(std::begin(ipv6.s6_addr) + 8, std::end(ipv6.s6_addr), 0);
  if (!inet_ntop(AF_INET6, &ipv6, canonical.data(), canonical.size())) return std::nullopt;
  return std::string(canonical.data());
}

bool AiInstallationPolicy::valid() const {
  return issuesPerDay > 0 && issuesPerDay <= 1'000 && generationsPerHour > 0 && generationsPerHour <= 10'000;
}

AiInstallations::AiInstallations(AiInstallationRepository& repository, std::shared_ptr<AiBudgetService> budgets,
                                 TokenGenerator& tokens, Clock& clock, std::optional<std::string> networkKey,
                                 AiInstallationPolicy policy)
    : repository_(repository), budgets_(std::move(budgets)), tokens_(tokens), clock_(clock),
      networkKey_(std::move(networkKey)), policy_(policy) {
  if (!budgets_ || (networkKey_ && (networkKey_->size() < 32 || networkKey_->size() > 1024)) || !policy_.valid())
    throw std::invalid_argument("invalid_ai_installation_configuration");
}

AiInstallationNetwork AiInstallations::network(const std::string& canonicalIp, long long atMs, bool issue) const {
  const auto address = aiInstallationNetworkAddress(canonicalIp);
  if (!address || !AiBudgetPeriod::at(atMs))
    throw std::invalid_argument("invalid_ai_installation_network");
  const long long window = issue ? 86'400'000 : 3'600'000;
  const long long start = atMs - atMs % window;
  const std::string input = std::string(issue ? "issue:" : "generation:") + std::to_string(start) + ":" + *address;
  std::array<unsigned char, EVP_MAX_MD_SIZE> digest{};
  unsigned int size = 0;
  if (!HMAC(EVP_sha256(), networkKey_->data(), static_cast<int>(networkKey_->size()),
            reinterpret_cast<const unsigned char*>(input.data()), input.size(), digest.data(), &size) || size != 32)
    throw std::runtime_error("ai_installation_network_digest_failed");
  static constexpr char hex[] = "0123456789abcdef";
  std::string value;
  value.reserve(64);
  for (unsigned int index = 0; index < size; ++index) {
    value.push_back(hex[digest[index] >> 4]);
    value.push_back(hex[digest[index] & 15]);
  }
  return {value, start + window, issue ? policy_.issuesPerDay : policy_.generationsPerHour};
}

AiInstallationIssue AiInstallations::issue(const std::string& canonicalIp) {
  if (!anonymousEnabled()) return {AiInstallationCode::Unavailable};
  const long long atMs = clock_.nowMs();
  const auto ceiling = network(canonicalIp, atMs, true);
  const auto token = tokens_.mint();
  if (!validAiInstallationCredential(token.secret) || token.digest.size() != 64)
    throw std::runtime_error("ai_installation_token_failed");
  const AiInstallationRow row{"installation_" + token.digest, token.digest, atMs};
  const auto code = repository_.issue(row, ceiling);
  if (code != AiInstallationCode::Ok) return {code};
  return {code, token.secret, AiInstallationPrincipal{row.id, std::nullopt}};
}

std::optional<AiInstallationPrincipal> AiInstallations::authenticate(const std::string& credential) {
  if (!validAiInstallationCredential(credential)) return std::nullopt;
  const auto row = repository_.find(tokens_.digestOf(credential));
  if (!row) return std::nullopt;
  return AiInstallationPrincipal{row->id, budgets_->boundAccount(row->id)};
}

AiInstallationCode AiInstallations::admitGeneration(const AiInstallationPrincipal& principal,
                                                   const std::string& requestId, const std::string& canonicalIp) {
  WriteObservation observation{"ai.installation.admit", "platform", "rest"};
  WriteContext context{observation};
  try {
    if (!anonymousEnabled()) {
      observation.finish("anonymous_ai_unavailable");
      return AiInstallationCode::Unavailable;
    }
    if (!validAiBudgetId(requestId)) {
      observation.finish("invalid");
      return AiInstallationCode::Invalid;
    }
    if (budgets_->boundAccount(principal.id())) {
      observation.finish("installation_bound");
      return AiInstallationCode::DeviceBound;
    }
    const long long atMs = clock_.nowMs();
    const auto code = repository_.admit(principal.id(), requestId, network(canonicalIp, atMs, false), atMs);
    observation.finish(std::string(aiInstallationCodeName(code)));
    return code;
  } catch (...) {
    observation.failUnknown();
    throw;
  }
}

AiBudgetCode AiInstallations::bind(const AiInstallationPrincipal& principal, const UserId& account) {
  return budgets_->bindDevice(principal.id(), account.str());
}

AiBudgetView AiInstallations::allowance(const AiInstallationPrincipal& principal) const {
  return budgets_->view({{AiBudgetSubjectKind::Device, principal.id()}, AiBudgetTier::Anonymous});
}

void AiInstallations::prune() {
  WriteObservation observation{"ai.installation.prune", "platform", "sweep"};
  WriteContext context{observation};
  const auto writes = observation.writeCount();
  try {
    repository_.prune(clock_.nowMs());
    if (observation.writeCount() == writes) observation.skip();
    else observation.finish();
  } catch (...) {
    observation.failUnknown();
    throw;
  }
}

}
