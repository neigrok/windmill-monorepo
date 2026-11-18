#include "products/roadmap/adapters/auth/ForkSignup.h"

#include <trantor/utils/Logger.h>
#include "platform/application/WriteObservation.h"

namespace wm {

ForkSignup::ForkSignup(TreeForks& fork) : fork_(fork) {}

std::optional<ForkDescription> ForkSignup::describe(const std::string& source) {
  std::optional<TreeForks::Description> described = fork_.describe(TreeId{source});
  if (!described) return std::nullopt;
  const std::string meta =
      described->steps == 1 ? "1 step" : std::to_string(described->steps) + " steps";
  return ForkDescription{described->title, meta};
}

std::optional<std::string> ForkSignup::plant(const std::string& source, const UserId& user) {
  WriteObservation observation("roadmap.signup.fork", "roadmap", "server-origin");
  WriteContext context(observation);
  try {
    // One sign-up plants one copy of its source, however often its answer is asked for again.
    TreeForks::Result r = fork_.fork(TreeId{source}, "", "", user, "signup-" + source);
    if (r.outcome == TreeForks::Outcome::forked) { observation.finish(); return r.data.id.str(); }
    observation.finish("source-missing-or-id-taken");
    LOG_WARN << "pending signup fork refused";
    return std::nullopt;
  } catch (const std::exception& e) {
    observation.fail(e);
    LOG_ERROR << "pending signup fork failed";
    return std::nullopt;
  }
}

}
