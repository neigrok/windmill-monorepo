#pragma once

#include "platform/adapters/postgres/PgPool.h"

#include <cstdlib>
#include <memory>
#include <string>

namespace wm {

// One pool for the whole test binary, shared by every Postgres case in it — and by the fixture
// resets, which outnumber the cases.
//
// Each of the four Postgres test files used to carry its own copy of a `connString()` helper and
// open a connection per case and per reset. That is how one `ctest` run came to open 157 Postgres
// connections in 1.1 seconds. Each one closes, and a closed loopback connection holds a TCP
// ephemeral port in TIME_WAIT for twice the maximum segment lifetime; macOS has 16,384 of those
// ports for the entire machine. A few agents each looping the suite is enough to exhaust them, and
// on 2026-08-08 it did — every outbound connection on the box failing with EADDRNOTAVAIL while
// ping and dig stayed green, because ICMP and UDP draw no ephemeral port.
//
// So borrow from here. The pool connects lazily, so a run without WM_PG_TEST still opens nothing.
inline const std::shared_ptr<PgPool>& pgTestPool() {
  static const std::shared_ptr<PgPool> pool = [] {
    const char* url = std::getenv("DATABASE_URL");
    return std::make_shared<PgPool>(url ? url : "postgresql://localhost/windmill");
  }();
  return pool;
}

}
