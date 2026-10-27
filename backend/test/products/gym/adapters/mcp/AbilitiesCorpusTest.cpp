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

// What a case starts from: the app's base URL when its answer links into the app, then the store, one record to a line.
std::string givenText(const Json::Value& given) {
  std::string out = "{\n";
  if (given.isMember("appBaseUrl")) out += "      \"appBaseUrl\": " + sync::jcs(given["appBaseUrl"]) + ",\n";
  out += "      \"records\": [";
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

// A record as the intent that wrote it holds it: its life and its client-written fields. A field the registry gives
// `writer: server` (a revision, an admission or settlement instant, a supersession, a frozen base) is the server's
// consequence of the write, which no replica writes, so it is never part of one.
struct Authored {
  std::string t;
  Json::Value id;
  bool alive = false;
  Json::Value f{Json::objectValue};

  bool operator==(const Authored& other) const { return alive == other.alive && sync::jcs(f) == sync::jcs(other.f); }
};

// The account's gym records as the engine feeds them, keyed by type and id, each as its writer authored it. A type
// with no client-written field, a `routineCreation` receipt, is the server's alone and never listed.
std::map<std::pair<std::string, std::string>, Authored> records(const UserId& account) {
  const auto catalog = sync::productCatalog();
  sync::PgSyncStore store{doortest::pool(), sync::Limits{}.lockTimeoutMs};
  const auto txn = store.begin(sync::TxnMode::snapshot);
  const auto scope = sync::ScopeKey::product(account, "gym");
  std::map<std::pair<std::string, std::string>, Authored> rows;
  for (const sync::TypeDef* type : catalog->typesIn(scope.registryScope())) {
    if (std::ranges::none_of(type->fields, [](const auto& field) { return field.second.writer == sync::Writer::client; })) continue;
    for (const sync::Row& row : catalog->store(type->name).feed(*txn, scope, sync::FeedQuery{})) {
      Authored authored{row.t, row.id.json(), row.alive()};
      for (const auto& [field, reg] : row.lattice.f)
        if (const sync::FieldDef* def = type->field(field); def && def->writer == sync::Writer::client) authored.f[field] = reg.value;
      rows.emplace(std::pair(row.t, row.id.key()), std::move(authored));
    }
  }
  return rows;
}

// INV-2's comparison: each record whose life or client-written fields the call changed, by type and id, with those
// fields and none of its stamps, seqs or receipt times. A record the server touched only in its own fields, a sibling
// proposal it superseded, is no write of the call's.
Json::Value writesBetween(const std::map<std::pair<std::string, std::string>, Authored>& before,
                          const std::map<std::pair<std::string, std::string>, Authored>& after) {
  std::set<std::pair<std::string, std::string>> keys;
  for (const auto& [key, record] : before) keys.insert(key);
  for (const auto& [key, record] : after) keys.insert(key);
  Json::Value writes(Json::arrayValue);
  for (const auto& key : keys) {
    const auto was = before.find(key);
    const auto now = after.find(key);
    if (was != before.end() && now != after.end() && was->second == now->second) continue;
    const Authored& record = now != after.end() ? now->second : was->second;
    Json::Value write(Json::objectValue);
    write["t"] = record.t;
    write["id"] = record.id;
    write["life"] = now != after.end() && now->second.alive ? "alive" : "dead";
    if (now != after.end()) write["f"] = now->second.f;
    writes.append(write);
  }
  return writes;
}

// One case on a fresh gym: the records seeded, the links minted, the clock at `now`, the call made as Coach makes it,
// by an executor that builds its links on the case's `appBaseUrl`.
Json::Value answer(const Json::Value& spec) {
  doortest::Harness h;
  h.clock.now = spec["now"].asUInt64();
  doortest::seed(h.user, spec["given"]["records"]);
  for (const Json::Value& session : spec["given"]["shares"])
    if (!h.training.share(h.user, SessionId{session.asString()})) throw std::runtime_error("no workout to share: " + session.asString());
  const auto before = records(h.user);

  GymTools tools{h.training, h.door, h.repo.catalog, h.repo.program, h.repo.notes, h.repo.bodyweight,
                 spec["given"].get("appBaseUrl", "").asString()};
  ReadReceipt run;
  const ToolResult result = tools.callTool(spec["call"]["name"].asString(), spec["call"]["input"],
                                           ToolCaller{h.user, ToolScope::everything()},
                                           ProposalSource{ProposalDoor::ask, "", "", std::nullopt}, run);
  const Json::Value writes = writesBetween(before, records(h.user));
  Json::Value expect(Json::objectValue);
  if (result.isError) {
    CHECK(writes.empty());
    expect["refused"] = toolWriteOutcome(result);
    return expect;
  }
  // A link is built on the base the case hands every executor, never on one only the server holds.
  if ((result.payload.isMember("reviewUrl") || result.payload.isMember("url")) && !spec["given"].isMember("appBaseUrl"))
    throw std::runtime_error("the answer links into the app and the case names no given.appBaseUrl");
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
