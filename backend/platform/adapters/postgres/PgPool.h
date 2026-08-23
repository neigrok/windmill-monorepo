#pragma once

#include <pqxx/pqxx>

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace wm {

// Every Postgres connection this process opens comes from here, never more than `maxConnections`
// alive at once. Borrow through PgLease, never by hand: a connection opened per unit of work
// strands a TCP ephemeral port in TIME_WAIT. Connections open lazily, a returned one stays open for
// the next borrower, and one that comes back broken is dropped.
class PgPool {
public:
  // Must sit above the number of borrowers that can be inside a handler at once. main.cpp sizes the
  // pool as ioThreads + kReservedConnections; this default is what a tool with no listener uses.
  static constexpr std::size_t kDefaultMaxConnections = 20;

  // Headroom over the IO threads for non-request borrowers: the heartbeat loops and the lease a
  // sweep holds across its whole pass.
  static constexpr std::size_t kReservedConnections = 8;

  // How long a borrower waits for the pool before giving up; a connection is held for one
  // transaction under a 5s statement_timeout, so waiting this long means a borrower leaked one.
  static constexpr std::chrono::milliseconds kDefaultAcquireTimeout{30'000};

  explicit PgPool(std::string connString, std::size_t maxConnections = kDefaultMaxConnections,
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
