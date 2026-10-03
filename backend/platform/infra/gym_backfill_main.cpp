#include "products/gym/sync/adapters/postgres/PgGymBackfill.h"
#include "platform/domain/sync/Jcs.h"

#include <chrono>
#include <cstdlib>
#include <iostream>

int main(int argc, char** argv) {
  const auto started = std::chrono::system_clock::now();
  const auto migrationTime = static_cast<wm::sync::Ms>(std::chrono::duration_cast<std::chrono::milliseconds>(started.time_since_epoch()).count());
  try {
    bool dryRun = false, audit = false, auditCurrent = false, testCorruptions = false;
    std::optional<std::string> account;
    for (int i = 1; i < argc; ++i) {
      const std::string arg = argv[i];
      if (arg == "--help") {
        std::cout << "windmill_gym_backfill [--dry-run | --audit [--test-corruptions] | --audit-current] [--account UUID]\nDATABASE_URL is required; freeze all gym writers and replicas before migration. Audit uses the immutable frozen source and recorded clock; corruption checks roll back every mutation. --audit-current checks admitted rows without comparing the frozen migration base.\n";
        return 0;
      }
      if (arg == "--dry-run") { dryRun = true; continue; }
      if (arg == "--audit") { audit = true; continue; }
      if (arg == "--audit-current") { auditCurrent = true; continue; }
      if (arg == "--test-corruptions") { testCorruptions = true; continue; }
      if (arg == "--account" && i + 1 < argc) { account = argv[++i]; continue; }
      throw std::invalid_argument("unknown or incomplete argument: " + arg);
    }
    if (int(audit) + int(auditCurrent) + int(dryRun) > 1) throw std::invalid_argument("--audit, --audit-current and --dry-run are mutually exclusive");
    if (testCorruptions && !audit) throw std::invalid_argument("--test-corruptions requires --audit");
    const char* url = std::getenv("DATABASE_URL");
    if (!url || !*url) throw std::invalid_argument("DATABASE_URL is required");
    wm::gym::engine::PgGymBackfill backfill(std::make_shared<wm::PgPool>(url));
    auto emit = [](const Json::Value& report) { std::cout << wm::sync::jcs(report) << '\n' << std::flush; };
    if (audit) {
      for (const auto& report : backfill.audit(account, testCorruptions)) emit(report);
      return 0;
    }
    if (auditCurrent) {
      for (const auto& report : backfill.auditCurrent(account)) emit(report);
      return 0;
    }
    backfill.run(migrationTime, dryRun, account, emit);
    return 0;
  } catch (const pqxx::sql_error& error) {
    std::cerr << "gym backfill: database operation failed (SQLSTATE " << error.sqlstate() << ")\n";
    return 1;
  } catch (const std::exception& error) {
    const std::string detail = error.what();
    const char* reason = "operation failed";
    if (detail.starts_with("C.8 digest/seq audit failed: ")) reason = "current feed digest or greatest seq mismatch";
    else if (detail.starts_with("C.8 frozen adoption audit failed: ")) reason = "frozen adoption validation failed";
    else if (detail.starts_with("C.8 adoption audit failed: ")) reason = "unadopted rows, spent ids or missing scope/source";
    else if (detail.starts_with("C.1 ")) reason = "adoption schema missing or incompatible";
    std::cerr << "gym backfill: " << reason << '\n';
    return 1;
  }
}
