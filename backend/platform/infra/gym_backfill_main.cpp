#include "platform/adapters/sentry/ObservedTool.h"

#include "products/gym/sync/adapters/postgres/PgGymBackfill.h"
#include "products/gym/sync/adapters/postgres/PgGymMetadataUpgrade.h"
#include "platform/domain/sync/Jcs.h"

#include <chrono>
#include <cstdlib>
#include <iostream>

int main(int argc, char** argv) {
  std::string operation = "gym.backfill";
  for (int i = 1; i < argc; ++i) {
    const std::string flag = argv[i];
    if (flag == "--audit") operation = "gym.audit";
    if (flag == "--audit-current") operation = "gym.audit_current";
    if (flag == "--upgrade-v5") operation = "gym.metadata_upgrade";
    if (flag == "--audit-v5") operation = "gym.metadata_audit";
    if (flag == "--dry-run") operation = "gym.backfill_dry_run";
  }
  return wm::runObservedTool(operation, "gym", [&](wm::WriteObservation& observation) {
    bool validated = false;
    const char* validationOutcome = "invalid-arguments";
    const auto started = std::chrono::system_clock::now();
    const auto migrationTime = static_cast<wm::sync::Ms>(std::chrono::duration_cast<std::chrono::milliseconds>(started.time_since_epoch()).count());
    try {
      bool dryRun = false, audit = false, auditCurrent = false, upgradeV5 = false, auditV5 = false, testCorruptions = false;
      std::optional<std::string> account;
      for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--help") {
          std::cout << "windmill_gym_backfill [--dry-run | --audit [--test-corruptions] | --audit-current | --upgrade-v5 | --audit-v5 [--test-corruptions]] [--account UUID]\nDATABASE_URL is required; freeze all gym writers and replicas before migration. Audit uses the immutable frozen source and recorded clock; corruption checks roll back every mutation. --audit-current checks admitted rows without comparing the frozen migration base. --upgrade-v5 requires db/gym_sync_v5.sql and resumes the immutable retained manifest and clock. --audit-v5 reconciles the stopped-writer supplement independently against that manifest.\n";
          return 0;
        }
        if (arg == "--dry-run") { dryRun = true; continue; }
        if (arg == "--audit") { audit = true; continue; }
        if (arg == "--audit-current") { auditCurrent = true; continue; }
        if (arg == "--upgrade-v5") { upgradeV5 = true; continue; }
        if (arg == "--audit-v5") { auditV5 = true; continue; }
        if (arg == "--test-corruptions") { testCorruptions = true; continue; }
        if (arg == "--account" && i + 1 < argc) { account = argv[++i]; continue; }
        throw std::invalid_argument("unknown or incomplete argument: " + arg);
      }
      if (int(audit) + int(auditCurrent) + int(dryRun) + int(upgradeV5) + int(auditV5) > 1) throw std::invalid_argument("migration and audit modes are mutually exclusive");
      if (testCorruptions && !audit && !auditV5) throw std::invalid_argument("--test-corruptions requires --audit or --audit-v5");
      validationOutcome = "not-configured";
      const char* url = std::getenv("DATABASE_URL");
      if (!url || !*url) throw std::invalid_argument("DATABASE_URL is required");
      validated = true;
      const auto pool = std::make_shared<wm::PgPool>(url);
      wm::gym::engine::PgGymBackfill backfill(pool);
      auto emit = [](const Json::Value& report) { std::cout << wm::sync::jcs(report) << '\n' << std::flush; };
      if (upgradeV5 || auditV5) {
        wm::gym::engine::PgGymMetadataUpgrade upgrade(pool);
        if (auditV5) for (const auto& report : upgrade.audit(account, testCorruptions)) emit(report);
        else upgrade.run(std::nullopt, account, emit);
        return 0;
      }
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
      observation.reportFailure(error);
      std::cerr << "gym backfill: database operation failed (SQLSTATE " << error.sqlstate() << ")\n";
      return 1;
    } catch (const std::exception& error) {
      if (!validated) observation.finish(validationOutcome);
      else observation.reportFailure(error);
      const std::string detail = error.what();
      const char* reason = "operation failed";
      if (detail.starts_with("C.8 digest/seq audit failed: ")) reason = "current feed digest or greatest seq mismatch";
      else if (detail.starts_with("C.8 frozen adoption audit failed: ")) reason = "frozen adoption validation failed";
      else if (detail.starts_with("C.8 adoption audit failed: ")) reason = "unadopted rows, spent ids or missing scope/source";
      else if (detail.starts_with("C.1 ")) reason = "adoption schema missing or incompatible";
      else if (detail.starts_with("C.10 ")) reason = "metadata upgrade manifest, completion or independent audit failed";
      std::cerr << "gym backfill: " << reason << '\n';
      return 1;
    }
  });
}
