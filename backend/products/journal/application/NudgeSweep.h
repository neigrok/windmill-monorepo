#pragma once

#include "platform/ports/Clock.h"
#include "platform/ports/TokenGenerator.h"
#include "products/journal/domain/NudgePlan.h"
#include "products/journal/ports/NudgeMailSender.h"
#include "products/journal/ports/NudgeRepository.h"

#include <trantor/net/EventLoopThread.h>

#include <cstdint>
#include <string>

namespace wm {

struct NudgeSweepReport {
  int sent = 0;
  int skipped = 0;
  int held = 0;      // decided-to-send but the arming gate withheld it
  int failed = 0;    // the provider refused delivery
};

// The daily-nudge heartbeat, cloned from roadmap's ReminderSweep: it owns its OWN trantor event-loop
// thread (never a drogon request loop, because the send blocks on a libpqxx/HTTP round trip) and
// holds NO schedule state — a sweep is a pure function of (now, database), so a restart loses
// nothing. Every pass is DECIDE → CLAIM → SEND, never reordered: the decision is pure, the claim is
// the ledger's PK mutex, and only a claimed, armed decision is ever mailed. run() is public so the
// admin endpoint can rehearse it at an arbitrary instant, dry or wet.
class NudgeSweep {
public:
  NudgeSweep(NudgeRepository& nudges, NudgeMailSender& mail, TokenGenerator& tokens, Clock& clock,
             NudgeArming arming, std::string appBaseUrl);

  void start();                                          // arm the ticker (jittered first tick, then periodic)
  NudgeSweepReport run(std::uint64_t nowMs, bool dryRun);
  const NudgeArming& arming() const { return arming_; }

private:
  void tick();
  NudgeCandidate candidateFor(const NudgeDueUser& due, std::uint64_t nowMs) const;
  bool deliver(const NudgeDueUser& due, const std::string& pauseSecret);

  NudgeRepository& nudges_;
  NudgeMailSender& mail_;
  TokenGenerator& tokens_;
  Clock& clock_;
  NudgeArming arming_;
  std::string appBaseUrl_;
  trantor::EventLoopThread ticker_;                      // declared last: destructs first, before deps
};

}
