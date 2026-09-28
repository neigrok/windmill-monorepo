#include "test/SyncCorpus.h"
#include "test/platform/adapters/postgres/PgSyncWorld.h"
#include "test/platform/application/sync/ServeCorpusRunners.h"
#include "test/platform/application/sync/SyncCorpusRunners.h"

// The golden corpus's server files replayed over Postgres (WM_PG_TEST), with the runners the domain binary
// runs over the fakes: the two backends answer every vector alike.

namespace {

using namespace wm::sync;

test::PgWorld& world() {
  static test::PgWorld pg;
  return pg;
}

const char* needsPostgres() {
  return test::postgresEnabled() ? nullptr : test::kNeedsPostgres;
}

[[maybe_unused]] const bool registered = [] {
  corpus::registerFiles(WM_SYNC_CONTRACT_DIR "/corpus",
                        std::map<std::string, std::variant<corpus::Runner, corpus::Transcript>>{
                            {"admit/", [](const Json::Value& input) { return test::admitVector(world(), input); }},
                            {"admit/requests.json", [](const Json::Value& input) { return test::requestsVector(world(), input); }},
                            {"push/serve.json", [](const Json::Value& input) { return test::pushVector(world(), input); }},
                            {"pull/serve.json", [](const Json::Value& input) { return test::pullVector(world(), input); }},
                            {"pull/hello.json", [](const Json::Value& input) { return test::helloVector(world(), input); }},
                            {"live/death.json", [](const Json::Value& input) { return test::liveDeathVector(world(), input); }},
                            {"protocol/", corpus::Transcript{[](const std::vector<Json::Value>& lines) { test::protocolTranscript(world(), lines); }}},
                        },
                        needsPostgres);
  return true;
}();

}
