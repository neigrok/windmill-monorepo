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

// SweepMutex against Postgres, shared by every product that sweeps on a schedule.
// The connection IS the lock: pg advisory locks are session-scoped, so this borrows exactly ONE
// lease and keeps it from the lock to the unlock with the whole pass in between.
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

    // Declared after the lock is held and destroyed before the lease is returned, so no early
    // return, throw or forgotten branch can skip the unlock.
    Handback handback{*conn, key_, name_};
    pass();
    return true;
  }

private:
  struct Handback {
    ~Handback() {
      // A connection that died released the lock on its way out, so the loud case is an unlock that
      // ran and found nothing to release.
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
      // The statement failed on a connection that is still OPEN. Closing it is what makes Postgres
      // release the lock with the session; the pool drops a closed connection.
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
