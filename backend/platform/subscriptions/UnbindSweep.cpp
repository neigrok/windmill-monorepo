#include "platform/subscriptions/UnbindSweep.h"

#include "platform/application/WriteObservation.h"

#include <trantor/utils/Logger.h>

#include <exception>
#include <stdexcept>
#include <string>

namespace wm::subscriptions {

namespace {
constexpr const char* kOperation = "subscription.unbind";
}

UnbindSweep::UnbindSweep(OwedUnbinds& owed, AccountUnbinder& service, Clock& clock, UnbindPace pace)
    : owed_(owed), service_(service), clock_(clock), pace_(pace) {}

void UnbindSweep::start() {
  LOG_INFO << "subscriptions: an erased account's unbind is repeated until the service takes it, every "
           << kPeriodSeconds << " s";
  heartbeat_.start(kFirstTickSeconds, kPeriodSeconds, [this] { pass(); });
}

void UnbindSweep::soon() {
  heartbeat_.queue([this] { pass(); });
}

void UnbindSweep::pass() {
  for (const OwedUnbind& owed : owed_.due(static_cast<std::int64_t>(clock_.nowMs()), kPerPass))
    if (!attempt(owed)) return;
}

// Taken, `ok`; a 404, `not_found`, settled and warned of, since the service never confirmed it unbound anything; still
// owed, `owed` with one line naming the service's answer, at ERROR and as the account's Issue when its report is due.
bool UnbindSweep::attempt(const OwedUnbind& owed) {
  WriteObservation observation{kOperation, "platform", "background", freshWriteRequestId()};
  WriteContext context{observation};
  try {
    const UnbindAnswer answer = service_.unbind(owed.account);
    if (answer.settled) {
      owed_.settle(owed.account);
      observation.wrote();
      if (answer.answer != "404") {
        observation.finish("ok");
        return true;
      }
      observation.finish("not_found");
      reportWriteWarning(kOperation, "platform", "background", "not_found", observation.requestId(), {});
      return true;
    }
    const std::int64_t now = static_cast<std::int64_t>(clock_.nowMs());
    const OwedUnbind after = owed.afterAttempt(now, pace_);
    owed_.keep(after);
    observation.wrote();
    LOG_WARN << "subscription unbind: an erased account's unbind is still owed to the service (answer=" << answer.answer
             << " attempt=" << after.attempts << ")";
    if (owed.reportDue(now, pace_)) {
      observation.fail(std::runtime_error{"the subscription service did not take an erased account's unbind"}, "owed");
      return true;
    }
    observation.finish("owed");
    return true;
  } catch (const std::exception& error) {
    observation.fail(error);
  } catch (...) {
    observation.failUnknown();
  }
  return false;
}

}
