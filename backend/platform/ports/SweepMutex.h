#pragma once

#include <functional>

namespace wm {

// Fleet-wide work lock a periodic sweep takes for one pass, so two processes do not duplicate the
// work; not a correctness mechanism. One scoped verb only: a Postgres advisory lock is
// session-scoped, so lock and unlock must stay on the same connection for the pass's whole life.
struct SweepMutex {
  virtual ~SweepMutex() = default;

  // Runs `pass` under the lock and answers true; false without running it when someone else holds
  // the lock. Whatever `pass` throws propagates, with the lock handed back first.
  virtual bool underSweepLock(const std::function<void()>& pass) = 0;
};

}
