#pragma once

#include <functional>

namespace wm {

// The fleet-wide work lock a periodic sweep takes for one pass, so two processes sharing one
// database cannot duplicate the WORK. It is deliberately not a correctness mechanism — the sweep's
// committed claim is — so a sweep stays correct with this running the pass and locking nothing.
// Postgres implements it as an advisory lock; a fake as a bool.
//
// It is ONE scoped verb, and that is the whole design. The pair it used to be —
// tryLockSweep()/unlockSweep() — let the Postgres side take the lock on one pooled connection and
// hand it back on whichever connection the pool lent next; advisory locks are SESSION-scoped, so
// under concurrent load the unlock landed on a session holding nothing, Postgres said nothing, and
// the real lock sat on an idle pooled connection for the life of the process. From that moment
// every sweep in every process on that database answered ran=false and no reminder and no nudge was
// ever sent again, silently. With one verb there is no unlock left for a caller to aim at the wrong
// connection, and the implementation has one obvious place to own the connection for the lock's
// whole life.
//
// A product's sweep repository inherits it the way it inherits MailSuppression: the store that
// knows who is due is the store the sweep locks around.
struct SweepMutex {
  virtual ~SweepMutex() = default;

  // Runs `pass` with the lock held and answers true. Answers false WITHOUT running it when someone
  // else already holds the lock. Whatever `pass` throws propagates, with the lock handed back first.
  virtual bool underSweepLock(const std::function<void()>& pass) = 0;
};

}
