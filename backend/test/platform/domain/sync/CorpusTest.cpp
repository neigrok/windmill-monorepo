#include "platform/domain/Ids.h"
#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/FractionalIndex.h"
#include "platform/domain/sync/Identity.h"
#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/Lattice.h"
#include "platform/domain/sync/Record.h"
#include "platform/domain/sync/Scope.h"
#include "platform/domain/sync/Wire.h"
#include "platform/domain/sync/TextMerge.h"

#include "test/SyncCorpus.h"
#include "test/platform/application/sync/ServeCorpusRunners.h"
#include "test/platform/application/sync/SyncCorpusRunners.h"
#include "products/probe/ProbeRegistry.h"

#include <algorithm>
#include <bit>
#include <cstdint>
#include <initializer_list>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

// The domain binary's reading of the golden corpus: every file of corpus/ is run here, pending, or the
// client's (test/SyncCorpus.h). Each runner answers a vector's input in the shape of its expect.

using namespace wm;
using namespace wm::sync;

namespace {

Json::Value object(std::initializer_list<std::pair<const char*, Json::Value>> members) {
  Json::Value value(Json::objectValue);
  for (const auto& [key, member] : members) value[key] = member;
  return value;
}

const TypeDef& probeType(const Json::Value& name) {
  const TypeDef* type = probe::registry().type(name.asString());
  if (!type) throw std::logic_error("the probe registry has no type " + name.asString());
  return *type;
}

HlcClock clockOf(const Json::Value& input) {
  const Json::Value& state = input["clock"];
  return HlcClock{input["actor"].asString(), HlcClock::State{state["ms"].asUInt64(), state["counter"].asUInt()}};
}

Json::Value stampsAndClock(const Json::Value& stamps, const HlcClock& clock) {
  const Json::Value state = object({{"ms", Json::UInt64(clock.state().ms)}, {"counter", Json::UInt(clock.state().counter)}});
  return object({{"stamps", stamps}, {"clock", state}});
}

Json::Value stampOrder(const Json::Value& input) {
  const Stamp a = stampOf(input["a"]);
  const Stamp b = stampOf(input["b"]);
  return object({{"order", a < b ? -1 : a == b ? 0 : 1}});
}

Json::Value stampCodec(const Json::Value& input) {
  const std::string text = input["text"].asString();
  const std::optional<Hlc> stamp = parseHlc(text);
  if (!stamp) return object({{"valid", false}});
  CHECK_EQ(toString(*stamp), text);
  return object({{"valid", true},
                 {"ms", Json::UInt64(stamp->physicalMs)},
                 {"counter", Json::UInt(stamp->counter)},
                 {"actor", stamp->actor}});
}

Json::Value hlcTick(const Json::Value& input) {
  HlcClock clock = clockOf(input);
  Json::Value stamps(Json::arrayValue);
  for (const Json::Value& physNow : input["physNow"]) stamps.append(toString(clock.tick(physNow.asUInt64())));
  return stampsAndClock(stamps, clock);
}

Json::Value hlcObserve(const Json::Value& input) {
  HlcClock clock = clockOf(input);
  Json::Value stamps(Json::arrayValue);
  for (const Json::Value& op : input["ops"]) {
    if (op.isMember("observe")) clock.observe(stampOf(op["observe"]));
    else stamps.append(toString(clock.tick(op["tick"].asUInt64())));
  }
  return stampsAndClock(stamps, clock);
}

Json::Value jcsValue(const Json::Value& input) {
  return corpus::refusedAs<JsonError>([&input] {
    if (!input.isMember("bits")) return object({{"jcs", jcs(parseJson(input["json"].asString()))}});
    const std::uint64_t bits = std::stoull(input["bits"].asString(), nullptr, 16);
    return object({{"jcs", jcs(Json::Value(std::bit_cast<double>(bits)))}});
  });
}

// A join answers the same whichever side each register comes from.
template <typename Part, typename Join>
Json::Value commutedJoin(const Json::Value& input, Join join) {
  auto partOf = [](const Json::Value& wire) { return wire.isNull() ? std::optional<Part>() : std::optional<Part>(Part(wire)); };
  auto wireOf = [](const std::optional<Part>& part) { return part ? part->toJson() : Json::Value(Json::nullValue); };
  const Json::Value forward = wireOf(join(partOf(input["a"]), partOf(input["b"])));
  const Json::Value backward = wireOf(join(partOf(input["b"]), partOf(input["a"])));
  CHECK_EQ(jcs(backward), jcs(forward));
  return object({{"join", forward}});
}

Json::Value lwwJoin(const Json::Value& input) {
  return commutedJoin<Reg>(input, joinLww);
}

Json::Value fwwJoin(const Json::Value& input) {
  return commutedJoin<Reg>(input, joinFww);
}

Json::Value rankedJoin(const Json::Value& input) {
  std::map<std::string, std::int64_t> rank;
  for (const std::string& value : input["rank"].getMemberNames()) rank[value] = input["rank"][value].asInt64();
  return commutedJoin<Reg>(input, [&rank](const std::optional<Reg>& a, const std::optional<Reg>& b) { return joinRanked(a, b, rank); });
}

Json::Value lifeJoin(const Json::Value& input) {
  return commutedJoin<Life>(input, joinLife);
}

Json::Value bornJoin(const Json::Value& input) {
  auto bornOf = [](const Json::Value& wire) { return wire.isNull() ? std::optional<Stamp>() : std::optional<Stamp>(stampOf(wire)); };
  auto wireOf = [](const std::optional<Stamp>& born) { return born ? Json::Value(toString(*born)) : Json::Value(Json::nullValue); };
  const Json::Value forward = wireOf(joinBorn(bornOf(input["a"]), bornOf(input["b"])));
  CHECK_EQ(jcs(wireOf(joinBorn(bornOf(input["b"]), bornOf(input["a"])))), jcs(forward));
  return object({{"join", forward}});
}

Json::Value recordJoin(const Json::Value& input) {
  const TypeDef& type = probeType(input["type"]);
  const LatticeRecord a(input["a"]);
  const LatticeRecord b(input["b"]);
  const Json::Value forward = joinRecord(type, a, b).toJson();
  CHECK_EQ(jcs(joinRecord(type, b, a).toJson()), jcs(forward));
  return object({{"join", forward}});
}

std::optional<std::string> keyOrOpenEnd(const Json::Value& key) {
  if (key.isNull()) return std::nullopt;
  return key.asString();
}

Json::Value orderKeyBetween(const Json::Value& input) {
  return corpus::refusedAs<OrderKeyError>(
      [&input] { return object({{"key", between(keyOrOpenEnd(input["a"]), keyOrOpenEnd(input["b"]))}}); });
}

Json::Value orderKeyDrop(const Json::Value& input) {
  auto membersOf = [](const Json::Value& list) {
    std::vector<OrderedMember> members;
    for (const Json::Value& member : list) members.push_back(OrderedMember{member["key"].asString(), member["id"].asString()});
    return members;
  };
  const std::vector<OrderedMember> stored = membersOf(input["stored"]);
  const std::vector<OrderedMember> drawn = membersOf(input["drawn"]);
  const std::string moved = input["moved"].asString();
  const std::string key = dropKey(stored, drawn, moved, keyOrOpenEnd(input["above"]));

  auto idsAfterTheMove = [&moved, &key](std::vector<OrderedMember> members) {
    for (OrderedMember& member : members) {
      if (member.id == moved) member.key = key;
    }
    std::sort(members.begin(), members.end());
    Json::Value ids(Json::arrayValue);
    for (const OrderedMember& member : members) ids.append(member.id);
    return ids;
  };
  std::vector<OrderedMember> drawnAfter = drawn;
  const bool placed = std::any_of(drawn.begin(), drawn.end(), [&moved](const OrderedMember& member) { return member.id == moved; });
  if (!placed) drawnAfter.push_back(OrderedMember{key, moved});
  return object({{"key", key}, {"drawn", idsAfterTheMove(drawnAfter)}, {"stored", idsAfterTheMove(stored)}});
}

Json::Value digestRow(const Json::Value& input) {
  return object({{"hash", rowHash(input["row"]).hex()}});
}

Json::Value digestScope(const Json::Value& input) {
  if (input.isMember("rows")) {
    const std::vector<Json::Value> rows(input["rows"].begin(), input["rows"].end());
    return object({{"digest", scopeDigest(rows).hex()}});
  }
  Digest256 digest = Digest256::fromHex(input["start"].asString()).value();
  for (const Json::Value& change : input["changes"]) digest = digest - rowHash(change["before"]) + rowHash(change["after"]);
  return object({{"digest", digest.hex()}});
}

Json::Value derivedId(const Json::Value& input) {
  std::set<std::string> taken;
  for (const Json::Value& id : input["taken"]) taken.insert(id.asString());
  return object({{"id", deriveId(input["label"].asString(), input["fallback"].asString(), taken)}});
}

Json::Value seededId(const Json::Value& input) {
  if (input["op"].asString() == "parse") {
    const std::optional<SeededId> parsed = SeededId::parse(input["id"].asString());
    if (!parsed) return object({{"parsed", Json::Value(Json::nullValue)}});
    return object({{"parsed", object({{"seed", parsed->seed}, {"n", Json::Int64(parsed->n)}})}});
  }
  const TypeDef& type = probeType(input["type"]);
  return corpus::refusedAs<std::invalid_argument>([&input, &type] {
    const Json::Value& n = input["n"];
    if (!n.isIntegral()) throw std::invalid_argument("an ordinal is an integer");
    return object({{"id", SeededId::of(type, input["seed"].asString(), n.asInt64()).text()}});
  });
}

Json::Value textTokens(const Json::Value& input) {
  Json::Value tokens(Json::arrayValue);
  for (const std::string& token : tokenize(input["text"].asString())) tokens.append(token);
  return object({{"tokens", tokens}});
}

Json::Value textScript(const Json::Value& input) {
  auto opName = [](EditOp op) { return op == EditOp::keep ? "keep" : op == EditOp::remove ? "delete" : "insert"; };
  Json::Value script(Json::arrayValue);
  for (const Edit& edit : editScript(tokenize(input["a"].asString()), tokenize(input["b"].asString()))) {
    Json::Value step(Json::arrayValue);
    step.append(opName(edit.op));
    step.append(edit.token);
    script.append(step);
  }
  return object({{"script", script}});
}

Json::Value textDiff3(const Json::Value& input) {
  const Diff3 merged = diff3(input["base"].asString(), input["head"].asString(), input["mine"].asString(), Limits{}.mergeWorkCells);
  return object({{"text", merged.text}, {"conflict", merged.conflict}});
}

Json::Value textMerge(const Json::Value& input) {
  const Json::Value& stored = input["stored"];
  const std::string head = stored["text"].asString();
  const Seq headRev = stored["rev"].asUInt64();
  const TextBase base = input["base"].isMember("rev") ? TextBase{input["base"]["rev"].asUInt64(), ""}
                                                      : TextBase{std::nullopt, input["base"]["text"].asString()};
  std::optional<std::string> revision;
  for (const Json::Value& kept : input["revisions"]) {
    if (base.rev && *base.rev != headRev && kept["rev"].asUInt64() == *base.rev) revision = kept["text"].asString();
  }

  const std::optional<TextMerge> merge = mergeText(head, headRev, base, input["mine"].asString(), revision, Limits{}.mergeWorkCells);
  if (!merge) return object({{"refuse", "base-unknown"}});
  return object({{"text", merge->text},
                 {"conflict", merge->conflict},
                 {"merged", mergedFlag(stored["merged"].asBool(), head, *merge)},
                 {"baseText", merge->baseText}});
}

// §4.1's op and §4.3's decision for one delta shape against one id state.
Json::Value identityTable(const Json::Value& input) {
  const TypeDef& type = probeType(input["type"]);
  Delta delta{.t = type.name, .id = sync::RecordId(std::string("x"))};
  delta.lattice = LatticeRecord(input["delta"]);
  const Op op = opOf(type, delta);
  static const std::map<std::string, IdState::Kind> kinds{
      {"none", IdState::Kind::none}, {"foreign", IdState::Kind::foreign}, {"alive", IdState::Kind::alive}, {"dead", IdState::Kind::dead}};
  const Json::Value& idState = input["idState"];
  IdState state{kinds.at(idState["state"].asString())};
  if (idState.isMember("born")) state.born = stampOf(idState["born"]);
  const Decision decision = decide(type, op, state, delta.lattice.born);
  static const char* verdicts[] = {"apply", "ok", "refuse"};
  Json::Value answer = object({{"op", std::string(nameOf(op))}, {"verdict", verdicts[static_cast<int>(decision.verdict)]}});
  if (decision.verdict == Decision::Verdict::refuse) answer["code"] = decision.code;
  return answer;
}

// §8.3's table: the target a transition reaches, or an error when the table has none (or not that one).
Json::Value scopeMachine(const Json::Value& input) {
  static const std::map<std::string, ScopeLife> lives{{"absent", ScopeLife::absent}, {"alive", ScopeLife::alive}, {"dead", ScopeLife::dead}};
  static const std::map<std::string, ScopeEvent> events{{"first-write", ScopeEvent::firstWrite},
                                                        {"governing-create", ScopeEvent::governingCreate},
                                                        {"governing-delete", ScopeEvent::governingDelete},
                                                        {"horizon", ScopeEvent::horizon}};
  const std::optional<ScopeLife> to = transition(lives.at(input["from"].asString()), events.at(input["event"].asString()));
  if (!to || (input.isMember("to") && lives.at(input["to"].asString()) != *to)) return object({{"error", true}});
  for (const auto& [name, life] : lives) {
    if (life == *to) return object({{"to", name}});
  }
  return object({{"error", true}});
}

// The constants the corpus assumes, against the ones the server applies.
void serverConstants(const Json::Value& constants) {
  const Limits limits;
  CHECK_EQ(constants["MAX_SKEW_MS"].asUInt64(), limits.maxSkewMs);
  CHECK_EQ(constants["K_POISON"].asInt(), limits.kPoison);
  CHECK_EQ(constants["LOCK_TIMEOUT_MS"].asUInt64(), limits.lockTimeoutMs);
  CHECK_EQ(constants["REQUEST_LEASE_MS"].asUInt64(), limits.requestLeaseMs);
  CHECK_EQ(constants["MAX_RECORD_BYTES"].asUInt64(), limits.maxRecordBytes);
  CHECK_EQ(constants["PUSH_MAX_INTENTS"].asUInt64(), limits.pushMaxIntents);
  CHECK_EQ(constants["PUSH_MAX_BYTES"].asUInt64(), limits.pushMaxBytes);
  CHECK_EQ(constants["PUSH_WORK_MS"].asUInt64(), limits.pushWorkMs);
  CHECK_EQ(constants["PULL_PAGE_BYTES"].asUInt64(), limits.pullPageBytes);
  CHECK_EQ(constants["PULL_MAX_SCOPES"].asUInt64(), limits.pullMaxScopes);
  CHECK_EQ(constants["LIVE_FRAME_BYTES"].asUInt64(), limits.liveFrameBytes);
  CHECK_EQ(constants["LIVE_INLINE_BYTES"].asUInt64(), limits.liveInlineBytes);
  CHECK_EQ(constants["MERGE_WORK_CELLS"].asUInt64(), limits.mergeWorkCells);
}

Json::Value admitOverFakes(const Json::Value& input) {
  test::FakeWorld world;
  return test::admitVector(world, input);
}

Json::Value requestsOverFakes(const Json::Value& input) {
  test::FakeWorld world;
  return test::requestsVector(world, input);
}

Json::Value pushOverFakes(const Json::Value& input) {
  test::FakeWorld world;
  return test::pushVector(world, input);
}

Json::Value pullOverFakes(const Json::Value& input) {
  test::FakeWorld world;
  return test::pullVector(world, input);
}

void transcriptOverFakes(const std::vector<Json::Value>& lines) {
  test::FakeWorld world;
  test::protocolTranscript(world, lines);
}

Json::Value helloOverFakes(const Json::Value& input) {
  test::FakeWorld world;
  return test::helloVector(world, input);
}

Json::Value liveDeathOverFakes(const Json::Value& input) {
  test::FakeWorld world;
  return test::liveDeathVector(world, input);
}

[[maybe_unused]] const bool registered = [] {
  corpus::registerCorpus(WM_SYNC_CORPUS_DIR, corpus::Claims{
      {"stamp/order.json", stampOrder},
      {"stamp/codec.json", stampCodec},
      {"hlc/tick.json", hlcTick},
      {"hlc/observe.json", hlcObserve},
      {"jcs/values.json", jcsValue},
      {"join/lww.json", lwwJoin},
      {"join/fww.json", fwwJoin},
      {"join/ranked.json", rankedJoin},
      {"join/life.json", lifeJoin},
      {"join/born.json", bornJoin},
      {"join/record.json", recordJoin},
      {"fracindex/between.json", orderKeyBetween},
      {"fracindex/drop.json", orderKeyDrop},
      {"digest/row.json", digestRow},
      {"digest/scope.json", digestScope},
      {"derive/slug.json", derivedId},
      {"identity/seeded.json", seededId},
      {"text/tokens.json", textTokens},
      {"text/script.json", textScript},
      {"text/diff3.json", textDiff3},
      {"text/merge.json", textMerge},

      {"constants.json", corpus::FileCheck{serverConstants}},
      {"identity/table.json", identityTable},
      {"machine/scope.json", scopeMachine},
      {"admit/", admitOverFakes},
      {"admit/requests.json", requestsOverFakes},
      {"push/serve.json", pushOverFakes},
      {"pull/serve.json", pullOverFakes},
      {"pull/hello.json", helloOverFakes},
      {"live/death.json", liveDeathOverFakes},
      {"protocol/", corpus::Transcript{transcriptOverFakes}},

      {"hlc/offset.json", corpus::ClientRole{"§10.4 offset samples"}},
      {"hlc/jump.json", corpus::ClientRole{"§10.4 device clock jumps"}},
      {"pull/pages.json", corpus::ClientRole{"§7.5 pages"}},
      {"machine/intent.json", corpus::ClientRole{"§8.1 intent machine"}},
      {"machine/replica.json", corpus::ClientRole{"§8.2 replica machine"}},
      {"view/", corpus::ClientRole{"§7.6 views"}},
      {"commit/", corpus::ClientRole{"§7.1 commit"}},
      {"coalesce/", corpus::ClientRole{"§7.2 coalescing"}},
      {"hold/", corpus::ClientRole{"§7.3 holds"}},
      {"refusal/", corpus::ClientRole{"§7.7 refusal and recovery"}},
      {"write/", corpus::ClientRole{"§7.7 write maps"}},
      {"lineage/", corpus::ClientRole{"§7.10 lineage"}},
  });
  return true;
}();

}
