#include "platform/adapters/postgres/PgPool.h"

#include "platform/application/StatementLimits.h"

#include <algorithm>
#include <stdexcept>
#include <utility>

namespace wm {

PgPool::PgPool(std::string connString, std::size_t maxConnections,
               std::chrono::milliseconds acquireTimeout)
    : connString_(std::move(connString)),
      maxConnections_(maxConnections > 0 ? maxConnections : 1),
      acquireTimeout_(acquireTimeout) {
  // Reserve up front so release() never allocates, which is what lets it be noexcept in a destructor.
  idle_.reserve(maxConnections_);
}

std::unique_ptr<pqxx::connection> PgPool::acquire(std::optional<std::chrono::milliseconds> wait) {
  std::unique_lock<std::mutex> lock{mutex_};
  for (;;) {
    while (!idle_.empty()) {
      std::unique_ptr<pqxx::connection> pooled = std::move(idle_.back());
      idle_.pop_back();
      if (pooled->is_open()) return pooled;
      --open_;  // it died while it sat here, so the slot it held is free again
    }
    if (open_ < maxConnections_) break;
    if (!returned_.wait_for(lock, wait.value_or(acquireTimeout_),
                            [this] { return !idle_.empty() || open_ < maxConnections_; }))
      throw PgPoolExhausted("postgres pool exhausted: all " + std::to_string(maxConnections_) +
                               " connections have been borrowed for longer than a transaction "
                               "should live, which means one was never returned");
  }

  // Claim the slot before letting go of the lock, or every waiter wakes and opens one at once.
  ++open_;
  lock.unlock();

  try {
    auto opened = std::make_unique<pqxx::connection>(connString_);
    pqxx::work txn{*opened};
    txn.exec("SET statement_timeout = '" + std::to_string(kStatementTimeout.count()) + "ms'");
    // Every statement here is a short one, planned on each call: compiling its plan costs more than running it.
    txn.exec("SET jit = off");
    txn.commit();
    return opened;
  } catch (...) {
    lock.lock();
    --open_;
    lock.unlock();
    returned_.notify_one();
    throw;
  }
}

void PgPool::release(std::unique_ptr<pqxx::connection> conn) noexcept {
  if (!conn) return;
  {
    std::lock_guard<std::mutex> lock{mutex_};
    if (conn->is_open()) idle_.push_back(std::move(conn));
    else --open_;
  }
  // A broken connection is destroyed here, outside the lock; the freed slot is what the waiter this wakes uses.
  returned_.notify_one();
}

PgLease::PgLease(PgPool& pool) : pool_(pool) {
  const StatementLimits* limits = StatementLimits::current();
  if (!limits) {
    conn_ = pool.acquire();
    return;
  }
  const std::chrono::milliseconds remaining = limits->remaining();
  if (remaining.count() <= 0) throw StatementDeadlinePassed{};
  conn_ = pool.acquire(remaining);
  try {
    pqxx::nontransaction session{*conn_};
    session.exec("SET lock_timeout = '" + std::to_string(limits->lockWait().count()) + "ms'; SET statement_timeout = '" +
                 std::to_string(std::min(remaining, PgPool::kStatementTimeout).count()) + "ms'");
  } catch (...) {
    // Half the limits may have been set: the connection is never lent again.
    try { conn_->close(); } catch (...) {}
    pool_.release(std::move(conn_));
    throw;
  }
  limited_ = true;
}

PgLease::~PgLease() {
  if (limited_) {
    try {
      pqxx::nontransaction session{*conn_};
      session.exec("SET lock_timeout = 0; SET statement_timeout = '" + std::to_string(PgPool::kStatementTimeout.count()) +
                   "ms'");
    } catch (...) {
      // A connection that may still carry the limits is never lent again.
      try { conn_->close(); } catch (...) {}
    }
  }
  pool_.release(std::move(conn_));
}

std::size_t PgPool::openConnections() const {
  std::lock_guard<std::mutex> lock{mutex_};
  return open_;
}

std::size_t PgPool::idleConnections() const {
  std::lock_guard<std::mutex> lock{mutex_};
  return idle_.size();
}

std::string redactDbUrl(const std::string& connString) {
  const std::size_t scheme = connString.find("://");
  const std::size_t at = connString.find('@');
  if (scheme == std::string::npos || at == std::string::npos || at < scheme) return connString;
  return connString.substr(0, scheme + 3) + "***@" + connString.substr(at + 1);
}

}
