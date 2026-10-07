#include "platform/adapters/postgres/PgPool.h"
#include "platform/adapters/sentry/ObservedTool.h"

#include <algorithm>
#include <cstdlib>
#include <stdexcept>
#include <string>

int main(int argc, char** argv) {
  using namespace wm;
  installToolObservability(true);
  ObservabilityLifetime lifetime;
  WriteObservation observation("sync.epoch.rotate", "platform", "tool");
  try {
    const std::string expected = argc == 3 ? argv[1] : "";
    const std::string replacement = argc == 3 ? argv[2] : "";
    if (expected.empty() || expected.size() > 128 || replacement.size() != 32 || expected == replacement ||
        !std::all_of(replacement.begin(), replacement.end(), [](char c) {
          return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
        })) {
      observation.finish("invalid-arguments");
      return 2;
    }
    const char* url = std::getenv("DATABASE_URL");
    if (!url || !*url) {
      observation.finish("configuration-unavailable");
      return 2;
    }
    setenv("PGCONNECT_TIMEOUT", "10", 0);
    PgPool pool(url, 1);
    PgLease conn{pool};
    pqxx::work txn{*conn};
    const pqxx::result rows = txn.exec("select epoch from sync_meta for update");
    if (rows.size() != 1) throw std::runtime_error("sync_meta must contain one row");
    const std::string current = rows[0][0].as<std::string>();
    if (current == replacement) {
      observation.finish("already-applied");
      return 0;
    }
    if (current != expected) {
      observation.finish("epoch-mismatch");
      return 2;
    }
    // The replacement is the saved restore receipt: retries serialize here and never rotate twice.
    txn.exec("update sync_meta set epoch = " + txn.quote(replacement));
    txn.commit();
    observation.finish();
    return 0;
  } catch (const std::exception& error) {
    observation.fail(error);
    return 1;
  } catch (...) {
    observation.failUnknown();
    return 1;
  }
}
