#include "platform/domain/sync/Admit.h"

#include "platform/domain/sync/Jcs.h"
#include "products/probe/ProbeRegistry.h"
#include "test/testing.h"

#include <optional>
#include <set>
#include <string>

// What the golden corpus cannot reach through the probe's product rules about ChangeSet (§6.1 step 10): the parent
// rule covers every create and update, a check's appended ones included, and reads the reference the join wrote,
// before G1 drops a dead record's fields.

using namespace wm;
using namespace wm::sync;

namespace {

Delta deltaOf(const std::string& t, const std::string& id, const std::string& lattice) {
  Delta delta{.t = t, .id = RecordId(id)};
  delta.lattice = LatticeRecord(parseJson(lattice));
  return delta;
}

Locked lockedAs(const TypeDef& type, const ScopeKey& scope, const std::string& id, const std::optional<Row>& typed) {
  return Locked::compose(type, scope, RecordId(id), typed, std::nullopt, false, std::nullopt);
}

// Whether checkParents refuses parent-dead, given the parents it looks up outside the intent.
bool refusesParentDead(const ChangeSet& changes, const std::map<RecordRef, std::optional<Row>>& storedParents) {
  try {
    changes.checkParents(storedParents);
  } catch (const Refusal& refusal) {
    return refusal.refused.code == code::parentDead;
  }
  return false;
}

}

TEST(the_parent_rule_reads_the_reference_the_join_wrote_before_g1_drops_a_dead_records_fields) {
  const Registry& registry = probe::registry();
  const TypeDef& lap = *registry.type("lap");
  const ScopeKey scope = ScopeKey::product(UserId{"A"}, "probe");
  const Row stored(parseJson(R"({"t": "lap", "id": "lap00001", "life": ["alive", "1000:0:r_aaaaaaaaaaaa"], "born": "1000:0:r_aaaaaaaaaaaa",
      "f": {"runId": ["run00001", "1000:0:r_aaaaaaaaaaaa"], "at": [1000, "1000:0:r_aaaaaaaaaaaa"], "weight": [1, "1000:0:r_aaaaaaaaaaaa"]},
      "v": {"no": 1}, "seq": 1, "rc": 1000, "ru": 1000})"));
  const Row run(parseJson(R"({"t": "run", "id": "run00001", "life": ["alive", "900:0:r_aaaaaaaaaaaa"], "born": "900:0:r_aaaaaaaaaaaa",
      "f": {"startedAt": [900, "900:0:r_aaaaaaaaaaaa"]}, "seq": 1, "rc": 900, "ru": 900})"));
  const RecordRef runRef{scope, "run", RecordId(std::string("run00001"))};
  ChangeSet changes(registry, scope, 5'000, Limits{});

  changes.admit(lap, scope, deltaOf("lap", "lap00001", R"({"born": "1000:0:r_aaaaaaaaaaaa", "f": {"weight": [2, "2000:0:r_aaaaaaaaaaaa"]}})"), Source::client,
                lockedAs(lap, scope, "lap00001", stored));
  changes.admit(lap, scope, deltaOf("lap", "lap00001", R"({"born": "1000:0:r_aaaaaaaaaaaa", "life": ["dead", "3000:0:srv"]})"), Source::check,
                lockedAs(lap, scope, "lap00001", stored));
  changes.join({}, {{scope.text(), 1}});

  REQUIRE(changes.changes().size() == 1u);
  CHECK_EQ(jcs(changes.changes()[0].after.toJson()),
           jcs(parseJson(R"({"t": "lap", "id": "lap00001", "life": ["dead", "3000:0:srv"], "born": "1000:0:r_aaaaaaaaaaaa", "seq": 0,
               "rc": 0, "ru": 0})")));
  CHECK(changes.parentsWanted() == std::set<RecordRef>{runRef});
  CHECK_FALSE(refusesParentDead(changes, {{runRef, run}}));
}

TEST(the_parent_rule_covers_a_create_a_check_appends) {
  const Registry& registry = probe::registry();
  const TypeDef& lap = *registry.type("lap");
  const ScopeKey scope = ScopeKey::product(UserId{"A"}, "probe");
  const Row endedRun(parseJson(R"({"t": "run", "id": "run00009", "life": ["dead", "4000:0:srv"], "born": "900:0:r_aaaaaaaaaaaa", "seq": 3})"));
  const RecordRef runRef{scope, "run", RecordId(std::string("run00009"))};
  ChangeSet changes(registry, scope, 5'000, Limits{});

  changes.admit(lap, scope,
                deltaOf("lap", "lap00002", R"({"life": ["alive", "5000:0:srv"], "born": "5000:0:srv",
                    "f": {"runId": ["run00009", "5000:0:srv"], "at": [5000, "5000:0:srv"], "weight": [1, "5000:0:srv"]}})"),
                Source::check, lockedAs(lap, scope, "lap00002", std::nullopt));
  changes.join({}, {{scope.text(), 3}});

  CHECK(changes.parentsWanted() == std::set<RecordRef>{runRef});
  CHECK(refusesParentDead(changes, {{runRef, endedRun}}));
}
