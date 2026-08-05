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

// Strip any `user:password@` credentials before a connection string reaches a log line. Every
// process that announces which database it opened goes through here.
inline std::string redactDbUrl(const std::string& connString) {
  const std::size_t scheme = connString.find("://");
  const std::size_t at = connString.find('@');
  if (scheme == std::string::npos || at == std::string::npos || at < scheme) return connString;
  return connString.substr(0, scheme + 3) + "***@" + connString.substr(at + 1);
}

}
