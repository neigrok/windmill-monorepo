#pragma once

#include <pqxx/pqxx>

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

namespace wm {

// Every connection stayed borrowed past the acquire timeout. Transient to the sync engine (§6.6).
struct PgPoolExhausted : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Every Postgres connection this process opens comes from here, never more than `maxConnections`
// alive at once. Borrow through PgLease, never by hand: a connection opened per unit of work
// strands a TCP ephemeral port in TIME_WAIT. Connections open lazily, a returned one stays open for
// the next borrower, and one that comes back broken is dropped.
class PgPool {
public:
  // The most connections this process holds. main.cpp sizes the pool as the smaller of this and its
  // borrowers (IO threads, sync workers, kReservedConnections); a tool with no listener takes it as is.
  // A borrower past the ceiling waits in acquire() holding nothing, so oversubscription is safe.
  static constexpr std::size_t kMaxConnections = 20;

  // Headroom for non-request borrowers: the heartbeat loops and the lease a sweep holds across its
  // whole pass.
  static constexpr std::size_t kReservedConnections = 8;

  // How long a borrower waits for the pool before giving up; a connection is held for one
  // transaction under a 5s statement_timeout, so waiting this long means a borrower leaked one.
  static constexpr std::chrono::milliseconds kDefaultAcquireTimeout{30'000};

  explicit PgPool(std::string connString, std::size_t maxConnections = kMaxConnections,
                  std::chrono::milliseconds acquireTimeout = kDefaultAcquireTimeout);

  std::unique_ptr<pqxx::connection> acquire();
  void release(std::unique_ptr<pqxx::connection> conn) noexcept;

  const std::string& connString() const { return connString_; }
  std::size_t maxConnections() const { return maxConnections_; }
  std::size_t openConnections() const;
  std::size_t idleConnections() const;

private:
  const std::string connString_;
  const std::size_t maxConnections_;
  const std::chrono::milliseconds acquireTimeout_;

  mutable std::mutex mutex_;
  std::condition_variable returned_;
  std::vector<std::unique_ptr<pqxx::connection>> idle_;
  std::size_t open_ = 0;  // idle plus borrowed: what the ceiling counts
};

// Declare the PgLease before the pqxx::work so the transaction is destroyed first, letting an
// uncommitted `pqxx::work` roll itself back on a connection that is still borrowed.
class PgLease {
public:
  explicit PgLease(PgPool& pool) : pool_(pool), conn_(pool.acquire()) {}
  ~PgLease() { pool_.release(std::move(conn_)); }

  PgLease(const PgLease&) = delete;
  PgLease& operator=(const PgLease&) = delete;

  pqxx::connection& operator*() const { return *conn_; }
  pqxx::connection* operator->() const { return conn_.get(); }

private:
  PgPool& pool_;
  std::unique_ptr<pqxx::connection> conn_;
};

// Strip any `user:password@` credentials before a connection string reaches a log line.
std::string redactDbUrl(const std::string& connString);

}
