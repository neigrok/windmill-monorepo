#pragma once

#include "platform/application/Heartbeat.h"
#include "platform/application/MailSweep.h"
#include "platform/domain/MailArming.h"
#include "platform/ports/Clock.h"
#include "platform/ports/TokenGenerator.h"
#include "products/journal/domain/NudgePlan.h"
#include "products/journal/ports/NudgeMailSender.h"
#include "products/journal/ports/NudgeRepository.h"

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace wm {

// MailSweep's decide -> claim -> send pipeline over journal's facts, on its own heartbeat thread
// rather than a drogon request loop. It holds no schedule state: a pass is a pure function of
// (now, database).
class NudgeSweep : public MailSweep<NudgeDueUser, NudgeDecision> {
public:
  NudgeSweep(NudgeRepository& nudges, NudgeMailSender& mail, TokenGenerator& tokens, Clock& clock,
             MailArming arming, std::string appBaseUrl);

  void start();                                          // arm the ticker (fixed first tick, then periodic)

  // Queued onto the sweep's own loop, which also serialises an operator's pass behind the
  // heartbeat's.
  void runAsync(std::uint64_t nowMs, bool dryRun, std::function<void(MailSweepReport)> done);

private:
  std::string name() const override { return "journal nudge"; }
  int batch() const override;
  std::vector<NudgeDueUser> dueNow(std::uint64_t nowMs, int limit) override;
  NudgeDecision decideFor(const NudgeDueUser& due, std::uint64_t nowMs) override;
  SweepVerdict verdictOf(const NudgeDecision& decision) const override;
  bool claim(const NudgeDueUser& due, const NudgeDecision& decision) override;
  void close(const NudgeDueUser& due, ClosedAs outcome) override;
  void send(const NudgeDueUser& due, const NudgeDecision& decision, const std::string& pauseSecret,
            std::function<void(bool)> done) override;
  void storePause(const UserId& user, const std::string& digest) override;

  NudgeRepository& nudges_;
  NudgeMailSender& mail_;
  Clock& clock_;
  std::string appBaseUrl_;
  Heartbeat heartbeat_;                                  // declared last: destructs first, before deps
};

}
