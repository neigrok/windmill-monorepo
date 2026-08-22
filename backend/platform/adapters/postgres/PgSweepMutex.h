#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "platform/ports/SweepMutex.h"

#include <pqxx/pqxx>
#include <trantor/utils/Logger.h>

#include <functional>
#include <memory>
#include <string>
#include <utility>

namespace wm {

// SweepMutex against Postgres, written once for every product that sweeps on a schedule — roadmap's
// weekly reminder and journal's nightly nudge had a copy each, and the copies shared a defect.
//
// The connection IS the lock: pg advisory locks are session-scoped, so this borrows exactly ONE
// lease and keeps it from the lock to the unlock with the whole pass in between. The shape it
// replaces borrowed a connection to take the lock and another to give it back, which under
// concurrent load unlocked a session that held nothing and stranded the real lock on an idle pooled
// connection forever (SWEEP-1). The unlock's answer is checked rather than assumed for the same
// reason: pg_advisory_unlock returns false instead of raising when it was aimed at nothing, and a
// mail engine that has quietly stopped is worth a line in the log the night it happens.
class PgSweepMutex : public SweepMutex {
public:
  PgSweepMutex(std::shared_ptr<PgPool> pool, std::string key, std::string name)
      : pool_(std::move(pool)), key_(std::move(key)), name_(std::move(name)) {}

  bool underSweepLock(const std::function<void()>& pass) override {
    PgLease conn{*pool_};
    {
      pqxx::work txn{*conn};
      const bool taken =
          txn.exec("SELECT pg_try_advisory_lock(" + key_ + ") AS taken")[0]["taken"].as<bool>();
      txn.commit();  // the lock is session-scoped, so it outlives this transaction by design
      if (!taken) return false;
    }

    // Declared after the lock is held and destroyed before the lease is returned, so the pass is the
    // only thing between them and no early return, no throw and no forgotten branch can skip it.
    Handback handback{*conn, key_, name_};
    pass();
    return true;
  }

private:
  struct Handback {
    ~Handback() {
      // Reaching the database is exactly the thing most likely to have just died, and a destructor
      // is noexcept — but a connection that died released the lock on its way out, so the loud case
      // is an unlock that ran and found nothing to release.
      try {
        pqxx::work txn{conn};
        const bool released =
            txn.exec("SELECT pg_advisory_unlock(" + key + ") AS released")[0]["released"].as<bool>();
        txn.commit();
        if (!released)
          LOG_ERROR << name << ": the sweep lock was handed back to a session that never held it — "
                               "the fleet lock is stranded and this engine has stopped sweeping";
        return;
      } catch (const std::exception& error) {
        LOG_ERROR << name << ": the sweep lock could not be handed back: " << error.what();
      } catch (...) {
        LOG_ERROR << name << ": the sweep lock could not be handed back";
      }
      // The statement failed on a connection that is still OPEN — a statement timeout, a recovery
      // conflict, a transient error. The pool would take that connection back and the lock would
      // ride it, held, for the life of the process: SWEEP-1 again through a second door. Closing it
      // is what makes Postgres release the lock with the session; the pool drops a closed
      // connection and the freed slot lets the next borrower open a live one.
      try {
        conn.close();
      } catch (...) {
      }
    }

    pqxx::connection& conn;
    const std::string& key;
    const std::string& name;
  };

  std::shared_ptr<PgPool> pool_;
  std::string key_;
  std::string name_;
};

}
