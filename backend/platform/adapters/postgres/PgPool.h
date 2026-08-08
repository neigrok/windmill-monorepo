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
// `maxConnections` alive at once.
//
// The rule the file exists to enforce is that a connection is BORROWED and RETURNED, never opened
// per unit of work. What stood here before kept one connection per thread, which is bounded only
// by how many threads happen to exist — so every short-lived thread opened a connection and closed
// it again on exit. A closed loopback connection holds a TCP ephemeral port in TIME_WAIT for twice
// the maximum segment lifetime, macOS has 16,384 of those ports for the whole machine, and the
// test suite alone opened 157 connections in 1.1 seconds. On 2026-08-08 that took the developer's
// box off the network entirely: 19,771 sockets in TIME_WAIT, 7,234 of them to ::1:5432, every new
// outbound TCP connection failing with EADDRNOTAVAIL while ping and dig stayed perfectly healthy.
//
// So connections are opened lazily — an idle process holds none — and a returned connection stays
// open for the next borrower rather than being closed. A connection that comes back broken is
// dropped instead of pooled, and the slot it frees lets the next borrower open a fresh one.
//
// Borrow through PgLease below, never through acquire/release by hand.
class PgPool {
public:
  // A ceiling, not a target. The server's borrowers are four drogon IO threads and three heartbeat
  // loops, so the steady state sits under eight and this number is never reached; it is here so
  // that a leak or a burst of short-lived threads waits for a connection instead of opening a
  // nine-thousandth one. Postgres itself allows 100 in total, which several local processes share.
  static constexpr std::size_t kDefaultMaxConnections = 20;

  // How long a borrower waits for the pool to hand something back before giving up. A connection is
  // held for one transaction and every connection carries a 5s statement_timeout, so waiting this
  // long means a borrower leaked one — a failure worth an exception rather than a silent hang.
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

// The borrow, scoped. Declare one, open the transaction on it, and let both go out of scope:
//
//   PgLease conn{*pool_};
//   pqxx::work txn{*conn};
//
// That order is not a style choice. The transaction is declared second so it is destroyed first,
// which is what lets an uncommitted `pqxx::work` roll itself back while the connection it rolls
// back on is still borrowed.
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

// Strip any `user:password@` credentials before a connection string reaches a log line. Every
// process that announces which database it opened goes through here.
std::string redactDbUrl(const std::string& connString);

}
