#include "platform/application/sync/ServerCall.h"

#include "platform/application/WorkerPool.h"
#include "platform/application/sync/Admission.h"
#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/Wire.h"

#include "test/platform/application/sync/SyncWorld.h"
#include "test/testing.h"

#include <variant>

// What admit/requests.json does not pin about ServerCall: a requestId that could name another call's part,
// and a finish by a call whose requestId another call holds.

using namespace wm;
using namespace wm::sync;

namespace {

Json::Value emptyProbe() {
  return parseJson(R"({"epoch": "ep-1", "clock": {"ms": 0, "counter": 0}, "accounts": {"A": {"name": "Ann"}},
      "scopes": {"acct:A/probe": {"kind": "product", "owner": "A", "state": "alive", "seq": 0, "counters": {},
          "digest": "0000000000000000000000000000000000000000000000000000000000000000"}}})");
}

Json::Value cardAdd(const std::string& id) {
  Json::Value intent = parseJson(R"({"scope": "self/probe", "d": [{"t": "card", "born": null, "life": ["alive", null],
      "f": {"title": ["One", null]}}]})");
  intent["d"][0]["id"] = id;
  return intent;
}

Digest256 callDigest(const Json::Value& args) {
  Json::Value call(Json::objectValue);
  call["tool"] = "cards.add";
  call["args"] = args;
  return intentDigest(call);
}

}

TEST(server_call_refuses_an_empty_request_id_or_one_holding_a_hash_invalid_and_admits_nothing) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  world.seed(emptyProbe());
  const Json::Value seeded = world.dump();
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
  const Json::Value args = parseJson(R"({"titles": ["One"]})");
  ServerCall hashed(admission, world.store(), world.account("A"), "req-1#1", "cards.add", args);
  ServerCall empty(admission, world.store(), world.account("A"), "", "cards.add", args);

  const AdmitOutcome hashedOutcome = hashed.admit(cardAdd("card0001"), 1'000'000);
  const AdmitOutcome emptyOutcome = empty.admit(cardAdd("card0001"), 1'000'000);

  const Json::Value invalid = parseJson(R"({"s": "refused", "code": "invalid"})");
  REQUIRE(std::holds_alternative<CallAnswered>(hashedOutcome));
  CHECK_EQ(jcs(std::get<CallAnswered>(hashedOutcome).result), jcs(invalid));
  REQUIRE(std::holds_alternative<CallAnswered>(emptyOutcome));
  CHECK_EQ(jcs(std::get<CallAnswered>(emptyOutcome).result), jcs(invalid));
  CHECK_EQ(jcs(world.dump()), jcs(seeded));
}

TEST(server_call_finish_leaves_the_row_of_another_call_holding_its_request_id) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  world.seed(emptyProbe());
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
  const Json::Value firstArgs = parseJson(R"({"titles": ["One"]})");
  ServerCall first(admission, world.store(), world.account("A"), "req-1", "cards.add", firstArgs);
  ServerCall second(admission, world.store(), world.account("A"), "req-1", "cards.add", parseJson(R"({"titles": ["Two"]})"));

  const AdmitOutcome admitted = first.admit(cardAdd("card0001"), 1'000'000);
  const AdmitOutcome conflicting = second.admit(cardAdd("card0002"), 1'000'000);
  second.finish(parseJson(R"({"s": "ok", "seq": 9})"), 1'000'000);

  REQUIRE(std::holds_alternative<Admitted>(admitted));
  CHECK_EQ(jcs(std::get<Admitted>(admitted).result), jcs(parseJson(R"({"s": "ok", "seq": 1})")));
  REQUIRE(std::holds_alternative<CallAnswered>(conflicting));
  CHECK_EQ(jcs(std::get<CallAnswered>(conflicting).result), jcs(parseJson(R"({"s": "refused", "code": "request-conflict"})")));
  Json::Value running = parseJson(R"({"A": [{"requestId": "req-1", "state": "running", "startedAt": 1000000,
      "parts": [{"k": 1, "result": {"s": "ok", "seq": 1}}]}]})");
  running["A"][0]["digest"] = callDigest(firstArgs).hex();
  CHECK_EQ(jcs(world.dump()["requests"]), jcs(running));

  first.finish(parseJson(R"({"s": "ok", "seq": 1})"), 1'000'000);

  Json::Value done = running;
  done["A"][0]["state"] = "done";
  done["A"][0]["result"] = parseJson(R"({"s": "ok", "seq": 1})");
  CHECK_EQ(jcs(world.dump()["requests"]), jcs(done));
}
