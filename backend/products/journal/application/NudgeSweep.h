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

// The daily-nudge sweep: platform/application/MailSweep.h's DECIDE → CLAIM → SEND pipeline over
// journal's own facts — who is due at the instant their device chose, whether they already wrote
// today, the daily ledger, and the one fixed-line nudge mail. It owns its OWN heartbeat thread
// (never a drogon request loop, because a send blocks on a libpqxx/HTTP round trip) and holds NO
// schedule state — a sweep is a pure function of (now, database), so a restart loses nothing.
// run() is public so the admin endpoint can rehearse it at an arbitrary instant, dry or wet.
class NudgeSweep : public MailSweep<NudgeDueUser, NudgeDecision> {
public:
  NudgeSweep(NudgeRepository& nudges, NudgeMailSender& mail, TokenGenerator& tokens, Clock& clock,
             MailArming arming, std::string appBaseUrl);

  void start();                                          // arm the ticker (fixed first tick, then periodic)

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
