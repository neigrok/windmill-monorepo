#include "products/probe/adapters/postgres/PgProbe.h"

#include "platform/adapters/postgres/PgSyncStore.h"
#include "platform/domain/sync/Jcs.h"
#include "test/platform/adapters/postgres/PgSyncWorld.h"
#include "test/testing.h"

#include <string>
#include <vector>

// The conformance every product's Postgres store passes, run over the probe's tables: apply stores exactly
// the row it is given, so feed(apply(x)) == x under JCS and the digest hashes what a page carries (§6.12),
// and lock, elsewhere, count, visibility, serials, revisions and purge all agree with what apply stored.

using namespace wm;
using namespace wm::sync;

namespace {

test::PgWorld& world() {
  static test::PgWorld pg;
  return pg;
}

// Accounts A and B with their probe scopes, A's public tree b_0000000a, and B's overlay of it.
void seedScopes() {
  world().seed(parseJson(R"({"epoch": "ep-1", "clock": {"ms": 0, "counter": 0}, "accounts": {"A": {"name": "Ann"}, "B": {"name": "Bob"}},
    "scopes": {
      "acct:A/probe": {"kind": "product", "owner": "A", "state": "alive", "seq": 0, "counters": {}, "digest": "0000000000000000000000000000000000000000000000000000000000000000"},
      "acct:B/probe": {"kind": "product", "owner": "B", "state": "alive", "seq": 0, "counters": {}, "digest": "0000000000000000000000000000000000000000000000000000000000000000"},
      "tree:b_0000000a": {"kind": "tree", "owner": "A", "state": "alive", "seq": 0, "counters": {}, "digest": "0000000000000000000000000000000000000000000000000000000000000000", "governedBy": "acct:A/probe#board#b_0000000a"},
      "acct:B/overlay/b_0000000a": {"kind": "overlay", "owner": "B", "state": "alive", "seq": 0, "counters": {}, "digest": "0000000000000000000000000000000000000000000000000000000000000000", "governedBy": "tree:b_0000000a"}
    }})"));
}

ScopeKey scopeOf(const std::string& aliasKey) {
  return world().storeKey(aliasKey);
}

void apply(const std::string& scope, const std::vector<std::string>& rows, const std::vector<TextRevision>& revisions = {}) {
  std::unique_ptr<SyncTxn> txn = world().store().begin(TxnMode::write);
  for (const std::string& wire : rows) {
    const Row row(parseJson(wire));
    world().catalog().store(row.t).apply(*txn, scopeOf(scope), {RowWrite{world().catalog().registry().type(row.t), row.id, std::nullopt, row, revisions}});
  }
  txn->commit();
}

std::vector<std::string> fed(const std::string& scope, const std::string& type, const FeedQuery& query = {}) {
  std::unique_ptr<SyncTxn> txn = world().store().begin(TxnMode::snapshot);
  std::vector<std::string> rows;
  for (const Row& row : world().catalog().store(type).feed(*txn, scopeOf(scope), query)) rows.push_back(jcs(row.toJson()));
  return rows;
}

std::vector<std::string> canonical(const std::vector<std::string>& rows) {
  std::vector<std::string> out;
  for (const std::string& row : rows) out.push_back(jcs(parseJson(row)));
  return out;
}

}

TEST(every_probe_table_stores_exactly_the_row_it_is_given) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  const std::vector<std::pair<std::string, std::vector<std::string>>> samples{
      {"acct:A/probe",
       {R"({"t":"board","id":"b_0000000a","life":["alive","2000:0:r_aaaaaaaaaaaa"],"born":"2000:0:r_aaaaaaaaaaaa","seq":1,"rc":1000,"ru":1000})",
        R"({"t":"board","id":"b_0000000b","life":["dead","2600:4:r_aaaaaaaaaaaa"],"born":"2001:0:r_aaaaaaaaaaaa","seq":2,"rc":1001,"ru":1500})"}},
      {"acct:A/probe",
       {R"({"t":"card","id":"card0001","life":["alive","3000:1:r_a:b c"],"born":"3000:1:r_a:b c","f":{
           "title":["Ünï ✓ \"q\"","3000:1:r_a:b c"],"body":["","3001:0:r_a"],"ord":["a0V","3002:0:r_a"],"size":[-12.34,"3003:0:r_a"],
           "claim":["x","3004:0:r_a"],"tier":["review","3005:0:r_a"],"attachment":[{"localOnly":true,"id":"picture1"},"3006:0:r_a"]},
           "seq":3,"rc":1002,"ru":1700})",
        R"({"t":"card","id":"card0002","life":["alive","3100:0:r_a"],"born":"3100:0:r_a","f":{"size":[null,"3101:0:r_a"],"attachment":[null,"3102:0:r_a"]},"seq":3,"rc":1003,"ru":1003})"}},
      {"acct:A/probe",
       {R"({"t":"run","id":"run00001","life":["alive","3500:0:srv"],"born":"3500:0:srv","f":{"startedAt":[1700000000000,"3500:0:srv"],"label":[null,"3500:0:srv"],"endedAt":[5,"3600:0:srv"]},"seq":4,"rc":1004,"ru":1004})"}},
      {"acct:A/probe",
       {R"({"t":"lap","id":"seedAAAA-1","life":["alive","3700:0:r_a"],"born":"3700:0:r_a","f":{"runId":["run00001","3700:0:r_a"],"at":[1700000000001,"3700:0:r_a"],"weight":[0.01,"3700:0:r_a"]},"v":{"no":3},"seq":5,"rc":1005,"ru":1005})"}},
      {"acct:A/probe", {R"({"t":"day","id":"2026-09-01","life":["alive","3800:0:r_a"],"f":{"score":[7,"3800:0:r_a"]},"seq":6,"rc":1006,"ru":1006})"}},
      {"tree:b_0000000a",
       {R"({"t":"meta","id":"meta","f":{"title":["Plan","2000:0:r_a"],"visibility":["public","2500:0:srv"]},"seq":1,"rc":1007,"ru":1007})"}},
      {"tree:b_0000000a",
       {R"({"t":"tag","id":"elm","life":["dead","2700:0:r_a"],"born":"2200:0:r_a","f":{"label":["Elm","2200:0:r_a"]},"seq":2,"rc":1008,"ru":1009})"}},
      {"tree:b_0000000a", {R"({"t":"link","id":["oak","elm"],"life":["dead","2800:0:r_a"],"seq":3,"rc":1010,"ru":1011})"}},
      {"acct:B/overlay/b_0000000a",
       {R"({"t":"mark","id":"oak","f":{"done":[null,"2400:0:r_b"]},"x":{"memo":{"text":"red 🌲 \"green\"\n","rev":4,"merged":true}},"seq":4,"rc":1012,"ru":1013})"}},
  };
  for (const auto& [scope, rows] : samples) {
    seedScopes();
    apply(scope, rows);
    const std::string type = Row(parseJson(rows.front())).t;
    CHECK_EQ(fed(scope, type), canonical(rows));
    CHECK_EQ(fed(scope, type, FeedQuery{.limit = 1}).size(), 1u);
    std::unique_ptr<SyncTxn> txn = world().store().begin(TxnMode::write);
    TypeStore& store = world().catalog().store(type);
    const Row first(parseJson(rows.front()));
    CHECK_EQ(jcs(store.lock(*txn, scopeOf(scope), {first.id}).at(first.id.key()).toJson()), jcs(parseJson(rows.front())));
    CHECK_EQ(store.count(*txn, scopeOf(scope), FeedQuery{}), rows.size());
    if (store.def().idSpace == IdSpace::global)
      CHECK_EQ(store.elsewhere(*txn, scopeOf("acct:B/probe"), {first.id}), (std::set<std::string>{first.id.key()}));
    store.purge(*txn, scopeOf(scope));
    CHECK_EQ(store.feed(*txn, scopeOf(scope), FeedQuery{}).size(), 0u);
  }
}

TEST(a_probe_row_rewritten_by_apply_holds_only_its_new_registers) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  seedScopes();
  apply("acct:A/probe", {R"({"t":"card","id":"card0001","life":["alive","1:0:r_a"],"born":"1:0:r_a","f":{"title":["One","1:0:r_a"],"size":[2.5,"1:0:r_a"]},"seq":1,"rc":10,"ru":10})"});
  apply("acct:A/probe", {R"({"t":"card","id":"card0001","life":["alive","1:0:r_a"],"born":"1:0:r_a","f":{"body":["b","2:0:r_a"]},"seq":2,"rc":10,"ru":20})"});
  CHECK_EQ(fed("acct:A/probe", "card"),
           canonical({R"({"t":"card","id":"card0001","life":["alive","1:0:r_a"],"born":"1:0:r_a","f":{"body":["b","2:0:r_a"]},"seq":2,"rc":10,"ru":20})"}));
}

TEST(probe_tables_answer_keysets_visibility_serials_and_revisions_as_stored) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  seedScopes();
  apply("acct:A/probe",
        {R"({"t":"lap","id":"lapAAAA1","life":["alive","1:0:r_a"],"born":"1:0:r_a","f":{"runId":["run00001","1:0:r_a"]},"v":{"no":3},"seq":2,"rc":1,"ru":1})",
         R"({"t":"lap","id":"lapAAAA2","life":["alive","1:0:r_a"],"born":"1:0:r_a","f":{"runId":["run00001","1:0:r_a"]},"v":{"no":7},"seq":2,"rc":1,"ru":1})",
         R"({"t":"lap","id":"lapAAAA3","life":["alive","1:0:r_a"],"born":"1:0:r_a","f":{"runId":["run00002","1:0:r_a"]},"v":{"no":9},"seq":3,"rc":1,"ru":1})"});
  std::unique_ptr<SyncTxn> txn = world().store().begin(TxnMode::write);
  TypeStore& laps = world().catalog().store("lap");
  CHECK_EQ(laps.maxSerial(*txn, scopeOf("acct:A/probe"), "no", {{"runId", Json::Value("run00001")}}), std::optional<std::int64_t>(7));
  CHECK_EQ(laps.maxSerial(*txn, scopeOf("acct:A/probe"), "no", {{"runId", Json::Value("run00003")}}), std::optional<std::int64_t>());
  std::vector<std::string> after;
  for (const Row& row : laps.feed(*txn, scopeOf("acct:A/probe"), FeedQuery{.afterSeq = 2, .afterKey = jcs(Json::Value("lapAAAA1"))})) after.push_back(row.id.column());
  CHECK_EQ(after, (std::vector<std::string>{"lapAAAA2", "lapAAAA3"}));
  txn->commit();

  apply("acct:B/overlay/b_0000000a",
        {R"({"t":"mark","id":"oak","f":{"done":[null,"1:0:r_b"]},"seq":1,"rc":1,"ru":1})",
         R"({"t":"mark","id":"elm","x":{"memo":{"text":"","rev":1,"merged":false}},"seq":1,"rc":1,"ru":1})",
         R"({"t":"mark","id":"ash","f":{"done":[false,"1:0:r_b"]},"seq":1,"rc":1,"ru":1})"},
        {TextRevision{"memo", 2, "older"}, TextRevision{"memo", 3, "old"}});
  CHECK_EQ(fed("acct:B/overlay/b_0000000a", "mark", FeedQuery{.visibleOnly = true}),
           canonical({R"({"t":"mark","id":"ash","f":{"done":[false,"1:0:r_b"]},"seq":1,"rc":1,"ru":1})"}));
  txn = world().store().begin(TxnMode::snapshot);
  TypeStore& marks = world().catalog().store("mark");
  CHECK_EQ(marks.revisionText(*txn, scopeOf("acct:B/overlay/b_0000000a"), RecordId(std::string("oak")), "memo", 3), std::optional<std::string>("old"));
  CHECK_EQ(marks.revisionText(*txn, scopeOf("acct:B/overlay/b_0000000a"), RecordId(std::string("oak")), "memo", 2), std::optional<std::string>());
}

TEST(a_text_value_holding_u0000_is_refused_by_the_store_never_stored_cut_short) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  seedScopes();
  std::string refused;
  try {
    apply("acct:B/overlay/b_0000000a", {R"({"t":"mark","id":"oak","x":{"memo":{"text":"red\u0000green","rev":1,"merged":false}},"seq":1,"rc":1,"ru":1})"});
  } catch (const std::invalid_argument& error) {
    refused = error.what();
  }
  CHECK_EQ(refused, std::string("a text value holds U+0000, which Postgres text cannot store"));
  CHECK_EQ(fed("acct:B/overlay/b_0000000a", "mark").size(), 0u);
}
