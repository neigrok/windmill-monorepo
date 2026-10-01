#include "products/gym/sync/adapters/postgres/PgGymBackfill.h"
#include "platform/domain/sync/Jcs.h"

#include <chrono>
#include <cstdlib>
#include <iostream>

int main(int argc, char** argv) {
  const auto started = std::chrono::system_clock::now();
  const auto migrationTime = static_cast<wm::sync::Ms>(std::chrono::duration_cast<std::chrono::milliseconds>(started.time_since_epoch()).count());
  try {
    bool dryRun = false, audit = false;
    std::optional<std::string> account;
    for (int i = 1; i < argc; ++i) {
      const std::string arg = argv[i];
      if (arg == "--help") {
        std::cout << "windmill_gym_backfill [--dry-run | --audit] [--account UUID]\nDATABASE_URL is required; freeze all gym writers and replicas before migration.\n";
        return 0;
      }
      if (arg == "--dry-run") { dryRun = true; continue; }
      if (arg == "--audit") { audit = true; continue; }
      if (arg == "--account" && i + 1 < argc) { account = argv[++i]; continue; }
      throw std::invalid_argument("unknown or incomplete argument: " + arg);
    }
    if (audit && dryRun) throw std::invalid_argument("--audit and --dry-run are mutually exclusive");
    const char* url = std::getenv("DATABASE_URL");
    if (!url || !*url) throw std::invalid_argument("DATABASE_URL is required");
    wm::gym::engine::PgGymBackfill backfill(std::make_shared<wm::PgPool>(url));
    auto emit = [](const Json::Value& report) { std::cout << wm::sync::jcs(report) << '\n' << std::flush; };
    if (audit) {
      for (const auto& report : backfill.audit(account)) emit(report);
      return 0;
    }
    backfill.run(migrationTime, dryRun, account, emit);
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "gym backfill: " << error.what() << '\n';
    return 1;
  }
}
