#pragma once

namespace wm {

// The fleet-wide work lock a periodic sweep takes for one pass, so two processes sharing one
// database cannot duplicate the WORK. It is deliberately not a correctness mechanism — the sweep's
// committed claim is — so a sweep stays correct with both of these returning true and doing
// nothing. Postgres implements it as an advisory lock; a fake as a bool.
//
// A product's sweep repository inherits it the way it inherits MailSuppression: the store that
// knows who is due is the store the sweep locks around.
struct SweepMutex {
  virtual ~SweepMutex() = default;

  virtual bool tryLockSweep() = 0;
  virtual void unlockSweep() = 0;
};

}
