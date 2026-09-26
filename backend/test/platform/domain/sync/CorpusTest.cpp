#include "platform/domain/Ids.h"
#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/FractionalIndex.h"
#include "platform/domain/sync/Identity.h"
#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/Lattice.h"
#include "platform/domain/sync/Record.h"

#include "test/SyncCorpus.h"
#include "test/platform/domain/sync/ProbeRegistry.h"

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
  return object({{"key", key}, {"drawn", idsAfterTheMove(drawn)}, {"stored", idsAfterTheMove(stored)}});
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

      {"constants.json", corpus::Pending{"the engine's constants arrive with their first reader, admission (M3)"}},
      {"identity/table.json", corpus::Pending{"the §4 identity table waits for the R100 spec pass"}},
      {"admit/", corpus::Pending{"§6.1 admission (M3) waits for the R100 spec pass"}},
      {"text/", corpus::Pending{"the §6.11 text merge waits for the R100 spec pass"}},
      {"machine/scope.json", corpus::Pending{"the §8.3 scope machine arrives with admission (M3)"}},
      {"push/serve.json", corpus::Pending{"§6.2 push arrives with SyncService (M4)"}},
      {"pull/serve.json", corpus::Pending{"§6.7 pull (M4) waits for the R100 spec pass"}},
      {"pull/hello.json", corpus::Pending{"§9.2 hello arrives with SyncService (M4)"}},
      {"protocol/", corpus::Pending{"the transcripts replay through SyncApi (M4)"}},

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
