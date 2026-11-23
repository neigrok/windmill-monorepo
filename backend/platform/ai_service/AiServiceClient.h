#pragma once

#include "platform/ai_passes/AiPasses.h"
#include "platform/ai_service/AiText.h"
#include "platform/ports/Clock.h"

#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <string>

namespace wm {

// The backend's client of the AI service's public text door (ai-service.md §6.1, §6.2), at the service's address inside
// the deployment, never through the proxy. Every call is an account's background work under a server pass the backend
// signs for that account (§3), each pass kept for half its lifetime. A call blocks its caller until it ends: it connects
// within kConnectSeconds, counts a stream silent for kSilentSeconds as broken (the service sends a heartbeat every
// 15 s), and gives up on an answer kDeadlineSeconds after it began, past the service's own 600 s on a call.
//
// A call is asked once more under the same callId and body when its stream breaks before `ended` or `failed`, or when
// nothing connected (§6.4), and once more under a pass signed again when the service answers `pass_expired` (§4).
// Every call logs one `ai_text_call` line: its operation and label, how it ended, how many times it was asked and how
// long it took, and never a prompt, an answer, a pass or a callId.
class AiServiceClient : public AiText {
public:
  AiServiceClient(std::string url, std::shared_ptr<const AiPasses> passes, Clock& clock);

  TextAnswer ask(const UserId& account, const TextQuestion& question) override;

  static constexpr long kConnectSeconds = 5;
  static constexpr long kSilentSeconds = 60;
  static constexpr long kDeadlineSeconds = 660;
  static constexpr std::uint64_t kPassKeptMs = kAiPassLifetimeMs / 2;

private:
  struct KeptPass {
    std::string pass;
    std::uint64_t signedAtMs = 0;
  };

  // The account's kept pass while it is younger than kPassKeptMs, or else one signed now.
  std::string keptPass(const UserId& account);
  // A pass signed now and kept in place of the account's last. Signing drops every kept pass past its time.
  std::string signedPass(const UserId& account);

  std::string url_;
  std::shared_ptr<const AiPasses> passes_;
  Clock& clock_;
  std::mutex lock_;
  std::map<std::string, KeptPass> kept_;
};

}
