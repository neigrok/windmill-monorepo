#include "platform/adapters/postgres/PgAuthRepository.h"
#include "test/PgTestPool.h"
#include "test/SyncCorpus.h"
#include "test/platform/adapters/postgres/PgSyncWorld.h"
#include "test/platform/application/sync/ServeCorpusRunners.h"
#include "test/platform/application/sync/SyncCorpusRunners.h"

// The golden corpus's server files replayed over Postgres (WM_PG_TEST), with the runners the domain binary
// runs over the fakes: the two backends answer every vector alike. envelope/credentials.json resolves its tokens
// against the sessions table.

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
                            {"gym/admit.json", [](const Json::Value& input) { static test::PgWorld gym(true); return test::gymAdmitVector(gym, input); }},
                            {"admit/", [](const Json::Value& input) { return test::admitVector(world(), input); }},
                            {"admit/requests.json", [](const Json::Value& input) { return test::requestsVector(world(), input); }},
                            {"push/serve.json", [](const Json::Value& input) { return test::pushVector(world(), input); }},
                            {"pull/serve.json", [](const Json::Value& input) { return test::pullVector(world(), input); }},
                            {"pull/hello.json", [](const Json::Value& input) { return test::helloVector(world(), input); }},
                            {"live/death.json", [](const Json::Value& input) { return test::liveDeathVector(world(), input); }},
                            {"envelope/credentials.json",
                             [](const Json::Value& input) {
                               wm::PgAuthRepository repo{wm::pgTestPool()};
                               return test::credentialsVector(repo, input);
                             }},
                            {"protocol/", corpus::Transcript{[](const std::vector<Json::Value>& lines) { test::protocolTranscript(world(), lines); }}},
                        },
                        needsPostgres);
  return true;
}();

}
