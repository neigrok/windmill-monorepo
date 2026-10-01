#pragma once

#include "platform/adapters/postgres/PgPool.h"

#include <cstdlib>
#include <memory>
#include <stdexcept>
#include <string>

#ifndef WM_PG_TEST_URL_ENV
#define WM_PG_TEST_URL_ENV "DATABASE_URL"
#endif

namespace wm {

// One pool for the whole test binary, shared by every Postgres case and every fixture reset. Never
// open a connection per case: a closed loopback connection holds a TCP ephemeral port in TIME_WAIT
// for twice the maximum segment lifetime, and macOS has 16,384 for the whole machine, so a looping
// suite exhausts them and every outbound connection on the box fails with EADDRNOTAVAIL.
// The pool connects lazily, so a run without WM_PG_TEST opens nothing.
inline const std::shared_ptr<PgPool>& pgTestPool() {
  static const std::shared_ptr<PgPool> pool = [] {
    const char* url = std::getenv(WM_PG_TEST_URL_ENV);
    if ((!url || !*url) && std::getenv("WM_PG_TEST")) {
      throw std::runtime_error(std::string("WM_PG_TEST requires ") + WM_PG_TEST_URL_ENV + ", see RUNNING.md §7");
    }
    return std::make_shared<PgPool>(url ? url : "postgresql://localhost/windmill");
  }();
  return pool;
}

}
