#pragma once

#include <string>
#include <vector>

namespace wm {

// Told, after their rows are gone, of every session deleted: a sign-out, a revoked session, sign-out everywhere, a
// closed account, and a folded account with every session its deleted row took with it. A live connection a deleted
// session opened closes at once, before it sends anything more (engine.md §6.8); AuthService is the only deleter of
// sessions, and each of its deletions tells this port.
struct SessionRevocations {
  virtual ~SessionRevocations() = default;
  virtual void revoked(const std::vector<std::string>& digests) = 0;
};

}
