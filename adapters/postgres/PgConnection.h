#pragma once

#include <pqxx/pqxx>

#include <memory>
#include <string>

namespace wm {

// One libpqxx connection per thread (pqxx::connection is not thread-safe): opened lazily on
// first use, reopened after a drop, and given a statement timeout on each fresh connection so
// a runaway query can't pin its Drogon event-loop thread forever.
inline pqxx::connection& pgThreadConnection(const std::string& connString) {
  thread_local std::unique_ptr<pqxx::connection> conn;
  if (!conn || !conn->is_open()) {
    conn = std::make_unique<pqxx::connection>(connString);
    pqxx::work txn{*conn};
    txn.exec("SET statement_timeout = '5s'");
    txn.commit();
  }
  return *conn;
}

}
