#include "products/gym/adapters/mcp/GymToolCatalog.h"

#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/Jcs.h"
#include "test/products/gym/sync/GymDoorFixture.h"
#include "test/testing.h"

#include <algorithm>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <map>
#include <set>
#include <string>
#include <utility>
#include <vector>

// packages/api-contract/gym/abilities (gym_coach.md §3.5) over the server executor, compared by JCS bytes and SHA-256;
// WM_GENERATE_ABILITIES=1 writes each `expect` from the server's answer, so the server is the golden source.
using namespace wm;
using namespace wm::gym;

namespace {

namespace fs = std::filesystem;

const fs::path kAbilities{WM_GYM_ABILITIES_DIR};

bool generating() { return std::getenv("WM_GENERATE_ABILITIES") != nullptr; }

Json::Value readJson(const fs::path& path) {
  std::ifstream stream(path, std::ios::binary);
  return sync::parseJson(std::string{std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()});
}

// One value per line at the depth where its JCS no longer fits, so a file reads case by case and diffs record by
// record; every number and string is printed as JCS prints it.
std::string pretty(const Json::Value& value, const std::string& indent) {
  const std::string flat = sync::jcs(value);
  if (indent.size() + flat.size() <= 120 || value.empty() || !(value.isObject() || value.isArray())) return flat;
  const std::string inner = indent + "  ";
  std::string out = value.isObject() ? "{\n" : "[\n";
  if (value.isObject()) {
    const std::vector<std::string> names = value.getMemberNames();
    for (std::size_t i = 0; i < names.size(); ++i)
      out += inner + sync::jcs(Json::Value(names[i])) + ": " + pretty(value[names[i]], inner) + (i + 1 < names.size() ? ",\n" : "\n");
  } else {
    for (Json::ArrayIndex i = 0; i < value.size(); ++i) out += inner + pretty(value[i], inner) + (i + 1 < value.size() ? ",\n" : "\n");
  }
  return out + indent + (value.isObject() ? "}" : "]");
}

// The store a case starts from, one record to a line.
std::string givenText(const Json::Value& given) {
  std::string out = "{\n      \"records\": [";
  const Json::Value& records = given["records"];
  for (Json::ArrayIndex i = 0; i < records.size(); ++i) out += std::string(i ? "," : "") + "\n        " + sync::jcs(records[i]);
  out += records.empty() ? "]" : "\n      ]";
  if (given.isMember("shares")) out += ",\n      \"shares\": " + sync::jcs(given["shares"]);
  return out + "\n    }";
}

// A file in the order a reader takes a case: what it is, the store it starts from, the call, and the answer.
std::string fileText(const Json::Value& cases) {
  std::string out = "[\n";
  for (Json::ArrayIndex i = 0; i < cases.size(); ++i) {
    out += "  {\n";
    const char* order[] = {"case", "seat", "now", "zone", "given", "call", "expect"};
    for (std::size_t k = 0; k < std::size(order); ++k) {
      const Json::Value& value = cases[i][order[k]];
      out += std::string("    ") + sync::jcs(Json::Value(order[k])) + ": " +
             (std::string(order[k]) == "given" ? givenText(value) : pretty(value, "    ")) + (k + 1 < std::size(order) ? ",\n" : "\n");
    }
    out += i + 1 < cases.size() ? "  },\n" : "  }\n";
  }
  return out + "]\n";
}

// The account's gym records as the engine feeds them, keyed by type and id.
std::map<std::pair<std::string, std::string>, sync::Row> records(const UserId& account) {
  const auto catalog = sync::productCatalog();
  sync::PgSyncStore store{doortest::pool(), sync::Limits{}.lockTimeoutMs};
  const auto txn = store.begin(sync::TxnMode::snapshot);
  const auto scope = sync::ScopeKey::product(account, "gym");
  std::map<std::pair<std::string, std::string>, sync::Row> rows;
  for (const sync::TypeDef* type : catalog->typesIn(scope.registryScope()))
    for (sync::Row& row : catalog->store(type->name).feed(*txn, scope, sync::FeedQuery{}))
      rows.emplace(std::pair(row.t, row.id.key()), std::move(row));
  return rows;
}

// The given records written straight into the account's gym scope, as the engine stores them, with the scope row
// that holds them: seq the greatest, counters for every capped type, digest the sum of the row hashes (§6.12).
void seed(const UserId& account, const Json::Value& given) {
  const auto catalog = sync::productCatalog();
  sync::PgSyncStore store{doortest::pool(), sync::Limits{}.lockTimeoutMs};
  const auto txn = store.begin(sync::TxnMode::write);
  const auto scope = sync::ScopeKey::product(account, "gym");
  store.insertScope(*txn, scope, account, std::nullopt);
  for (const sync::TypeDef* type : catalog->applyOrder())
    for (const Json::Value& wire : given) {
      const sync::Row row(wire);
      if (row.t == type->name) catalog->store(row.t).apply(*txn, scope, {sync::RowWrite{type, row.id, std::nullopt, row, {}}});
    }
  sync::ScopeRow stored = *store.scope(*txn, scope, sync::RowLock::update);
  for (const sync::TypeDef* type : catalog->typesIn(scope.registryScope()))
    for (const sync::Row& row : catalog->store(type->name).feed(*txn, scope, sync::FeedQuery{})) {
      stored.digest = stored.digest + sync::rowHash(row.toJson());
      stored.seq = std::max(stored.seq, row.seq);
      if (type->cap && row.alive()) ++stored.counters[type->name];
    }
  store.saveScope(*txn, stored);
  txn->commit();
}

// INV-2's comparison: each record the call created, changed or killed, by type and id, with its field values and
// none of its stamps, seqs, receipt times or serials.
Json::Value writesBetween(const std::map<std::pair<std::string, std::string>, sync::Row>& before,
                          const std::map<std::pair<std::string, std::string>, sync::Row>& after) {
  std::set<std::pair<std::string, std::string>> keys;
  for (const auto& [key, row] : before) keys.insert(key);
  for (const auto& [key, row] : after) keys.insert(key);
  Json::Value writes(Json::arrayValue);
  for (const auto& key : keys) {
    const auto was = before.find(key);
    const auto now = after.find(key);
    if (was != before.end() && now != after.end() && sync::jcs(was->second.toJson()) == sync::jcs(now->second.toJson())) continue;
    const sync::Row& row = now != after.end() ? now->second : was->second;
    Json::Value write(Json::objectValue);
    write["t"] = row.t;
    write["id"] = row.id.json();
    write["life"] = now != after.end() && now->second.alive() ? "alive" : "dead";
    if (now != after.end()) {
      write["f"] = Json::Value(Json::objectValue);
      for (const auto& [field, reg] : now->second.lattice.f) write["f"][field] = reg.value;
    }
    writes.append(write);
  }
  return writes;
}

// One case on a fresh gym: the records seeded, the links minted, the clock at `now`, the call made as Coach makes it.
Json::Value answer(const Json::Value& spec) {
  doortest::Harness h;
  h.clock.now = spec["now"].asUInt64();
  seed(h.user, spec["given"]["records"]);
  for (const Json::Value& session : spec["given"]["shares"])
    if (!h.training.share(h.user, SessionId{session.asString()})) throw std::runtime_error("no workout to share: " + session.asString());
  const auto before = records(h.user);

  ReadReceipt run;
  const ToolResult result = h.tools.callTool(spec["call"]["name"].asString(), spec["call"]["input"],
                                             ToolCaller{h.user, ToolScope::everything()},
                                             ProposalSource{ProposalDoor::ask, "", "", std::nullopt}, run);
  const Json::Value writes = writesBetween(before, records(h.user));
  Json::Value expect(Json::objectValue);
  if (result.isError) {
    CHECK(writes.empty());
    expect["refused"] = toolWriteOutcome(result);
    return expect;
  }
  expect["result"] = result.payload;
  expect["sha256"] = sync::sha256(sync::jcs(result.payload)).hex();
  expect["writes"] = writes;
  return expect;
}

// Generation rewrites a whole file after each of its cases, so the cases of one file share one copy.
std::map<fs::path, Json::Value>& generated() {
  static std::map<fs::path, Json::Value> files;
  return files;
}

void runCase(const fs::path& file, Json::ArrayIndex index) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  const Json::Value spec = readJson(file)[index];
  REQUIRE_EQ(spec["call"]["name"].asString(), file.stem().string());
  CHECK(spec["seat"] == "bound" || spec["seat"] == "anon");
  const Json::Value answered = answer(spec);
  if (generating()) {
    auto [copy, fresh] = generated().try_emplace(file, readJson(file));
    copy->second[index]["expect"] = answered;
    std::ofstream(file, std::ios::binary | std::ios::trunc) << fileText(copy->second);
    return;
  }
  const Json::Value& expect = spec["expect"];
  if (sync::jcs(answered) != sync::jcs(expect))
    ::testing::fail(("answer " + sync::jcs(answered) + "\n       expect " + sync::jcs(expect)).c_str(), __FILE__, __LINE__);
  if (expect.isMember("result")) CHECK_EQ(sync::sha256(sync::jcs(expect["result"])).hex(), expect["sha256"].asString());
}

// One case per entry of every file, named by its file and its `case`.
[[maybe_unused]] const bool registered = [] {
  if (!fs::is_directory(kAbilities)) {
    ::testing::Register{"gym_abilities", [] { ::testing::fail(("no ability corpus at " + kAbilities.string()).c_str(), __FILE__, __LINE__); }};
    return true;
  }
  std::set<fs::path> files;
  for (const auto& entry : fs::directory_iterator(kAbilities))
    if (entry.is_regular_file() && entry.path().extension() == ".json") files.insert(entry.path());
  for (const fs::path& file : files) {
    const Json::Value cases = readJson(file);
    for (Json::ArrayIndex i = 0; i < cases.size(); ++i)
      ::testing::Register{"gym_abilities/" + file.filename().string() + ": " + cases[i]["case"].asString(), [file, i] { runCase(file, i); }};
  }
  return true;
}();

}

// Every ability Coach is offered and the server declares has a file, every read at least two cases, and no file
// speaks for an ability the catalog withholds or the server cannot run.
TEST(gym_abilities_cover_every_offered_server_ability) {
  std::set<std::string> offered;
  std::set<std::string> reads;
  const Json::Value catalog = sync::parseJson(catalogText());
  for (const Json::Value& ability : catalog["abilities"]) {
    if (ability["agent"] == "withheld" || !ability.get("declared", true).asBool()) continue;
    offered.insert(ability["name"].asString());
    if (ability["class"] == "read") reads.insert(ability["name"].asString());
  }
  std::set<std::string> covered;
  for (const auto& entry : fs::directory_iterator(kAbilities)) {
    if (entry.path().extension() != ".json") continue;
    const std::string name = entry.path().stem().string();
    covered.insert(name);
    CHECK(offered.contains(name));
    const Json::Value cases = readJson(entry.path());
    REQUIRE(cases.isArray());
    CHECK(cases.size() >= (reads.contains(name) ? 2u : 1u));
    std::set<std::string> names;
    for (const Json::Value& one : cases) CHECK(names.insert(one["case"].asString()).second);
  }
  CHECK(covered == offered);
}
