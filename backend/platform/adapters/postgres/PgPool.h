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

// Every Postgres connection this process opens comes from here, and there are never more than
// `maxConnections` alive at once. A connection is BORROWED and RETURNED, never opened per unit of
// work: a closed loopback connection holds a TCP ephemeral port in TIME_WAIT and macOS has 16,384
// of them for the whole machine. Connections open lazily, a returned connection stays open for the
// next borrower, and one that comes back broken is dropped. Borrow through PgLease, never by hand.
class PgPool {
public:
  // A ceiling that must sit ABOVE the number of borrowers that can be inside a handler at once, or
  // the pool turns a busy moment into 30-second waits and 500s. main.cpp sizes the pool as ioThreads
  // + kReservedConnections; this default is what a tool with no listener uses.
  static constexpr std::size_t kDefaultMaxConnections = 20;

  // Headroom over the IO threads for borrowers that are not request threads: the heartbeat loops,
  // plus the lease a sweep holds across its whole pass.
  static constexpr std::size_t kReservedConnections = 8;

  // How long a borrower waits for the pool before giving up. A connection is held for one transaction
  // and carries a 5s statement_timeout, so waiting this long means a borrower leaked one.
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

// The borrow, scoped:
//
//   PgLease conn{*pool_};
//   pqxx::work txn{*conn};
//
// The transaction is declared second so it is destroyed first, which is what lets an uncommitted
// `pqxx::work` roll itself back on a connection that is still borrowed.
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
