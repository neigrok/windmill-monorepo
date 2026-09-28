#pragma once

#include <string>
#include <vector>

namespace wm {

// Told, after their rows are gone, of the sessions the account service revoked: a sign-out, a revoked session,
// sign-out everywhere, a closed or folded account. A live connection a revoked session opened closes at once,
// before it sends anything more (engine.md §6.8).
struct SessionRevocations {
  virtual ~SessionRevocations() = default;
  virtual void revoked(const std::vector<std::string>& digests) = 0;
};

}
