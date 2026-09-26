#include "platform/domain/sync/Lattice.h"

#include "platform/domain/sync/Jcs.h"

#include "test/platform/domain/sync/ProbeRegistry.h"
#include "test/testing.h"

#include <algorithm>
#include <cstdint>
#include <functional>
#include <optional>
#include <random>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::sync;

// §11.2.1: the §3.3 laws for every lattice join, ranked included, over generators that make equal
// stamps, equal ranks, equal encodings and absent registers common. Single joins are pinned by
// sync_corpus/join/*.

namespace {

// Few ms, counters and actors, so stamps tie often; values of equal JCS in different jsoncpp forms
// (9 and 9.0), and values whose UTF-8 and UTF-16 orders differ.
class Generator {
public:
  explicit Generator(std::uint64_t seed) : random_(seed) {}

  int pick(int bound) { return static_cast<int>(random_() % static_cast<std::uint64_t>(bound)); }

  Stamp stamp() { return Stamp{static_cast<std::uint64_t>(pick(3)), static_cast<std::uint32_t>(pick(2)), pick(2) ? "r_a" : "r_b"}; }

  Json::Value value() {
    switch (pick(9)) {
      case 0: return Json::Value("a");
      case 1: return Json::Value("b");
      case 2: return Json::Value(9);
      case 3: return Json::Value(9.0);
      case 4: return Json::Value(10);
      case 5: return Json::Value(Json::nullValue);
      case 6: return Json::Value(false);
      case 7: return Json::Value("\xef\xac\xb3");
      default: return Json::Value("\xf0\x9f\x98\x80");
    }
  }

  std::optional<Reg> reg() {
    if (pick(5) == 0) return std::nullopt;
    return Reg{value(), stamp()};
  }

  std::optional<Reg> rankedReg() {
    if (pick(5) == 0) return std::nullopt;
    static const char* const kTiers[] = {"draft", "review", "done", "dropped"};
    return Reg{Json::Value(kTiers[pick(4)]), stamp()};
  }

  std::optional<Life> life() {
    if (pick(5) == 0) return std::nullopt;
    return Life{pick(2) ? LifeState::alive : LifeState::dead, stamp()};
  }

  std::optional<Stamp> born() {
    if (pick(5) == 0) return std::nullopt;
    return stamp();
  }

  // A probe card's lattice part: an lww, an fww and a ranked register, each maybe absent.
  LatticeRecord card() {
    LatticeRecord record;
    record.life = life();
    record.born = born();
    if (std::optional<Reg> title = reg()) record.f.emplace("title", *title);
    if (std::optional<Reg> claim = reg()) record.f.emplace("claim", *claim);
    if (std::optional<Reg> tier = rankedReg()) record.f.emplace("tier", *tier);
    return record;
  }

private:
  std::mt19937_64 random_;
};

std::string wire(const std::optional<Reg>& reg) { return reg ? jcs(reg->toJson()) : "absent"; }
std::string wire(const std::optional<Life>& life) { return life ? jcs(life->toJson()) : "absent"; }
std::string wire(const std::optional<Stamp>& born) { return born ? toString(*born) : "absent"; }
std::string wire(const LatticeRecord& record) { return jcs(record.toJson()); }

// Idempotent, commutative and associative, with the absent register as identity, over `rounds`
// triples the generator draws.
template <typename Part>
void checkLaws(std::uint64_t seed, const std::function<Part(Generator&)>& draw, const std::function<Part(const Part&, const Part&)>& join) {
  Generator generator(seed);
  for (int round = 0; round < 3000; ++round) {
    const Part a = draw(generator);
    const Part b = draw(generator);
    const Part c = draw(generator);
    CHECK_EQ(wire(join(a, a)), wire(a));
    CHECK_EQ(wire(join(a, b)), wire(join(b, a)));
    CHECK_EQ(wire(join(join(a, b), c)), wire(join(a, join(b, c))));
    CHECK_EQ(wire(join(a, Part{})), wire(a));
    CHECK_EQ(wire(join(Part{}, a)), wire(a));
  }
}

const std::map<std::string, std::int64_t>& tierRanks() {
  return probe::registry().type("card")->fields.at("tier").rank;
}

}

TEST(lww_joins_obey_the_lattice_laws) {
  checkLaws<std::optional<Reg>>(1, &Generator::reg, joinLww);
}

TEST(fww_joins_obey_the_lattice_laws) {
  checkLaws<std::optional<Reg>>(2, &Generator::reg, joinFww);
}

TEST(ranked_joins_obey_the_lattice_laws_with_equal_ranks) {
  checkLaws<std::optional<Reg>>(3, &Generator::rankedReg, [](const std::optional<Reg>& a, const std::optional<Reg>& b) {
    return joinRanked(a, b, tierRanks());
  });
}

TEST(life_joins_obey_the_lattice_laws) {
  checkLaws<std::optional<Life>>(4, &Generator::life, joinLife);
}

TEST(born_joins_obey_the_lattice_laws) {
  checkLaws<std::optional<Stamp>>(5, &Generator::born, joinBorn);
}

TEST(record_joins_obey_the_lattice_laws) {
  const TypeDef& card = *probe::registry().type("card");
  Generator generator(6);
  for (int round = 0; round < 3000; ++round) {
    const LatticeRecord a = generator.card();
    const LatticeRecord b = generator.card();
    const LatticeRecord c = generator.card();
    CHECK_EQ(wire(joinRecord(card, a, a)), wire(a));
    CHECK_EQ(wire(joinRecord(card, a, b)), wire(joinRecord(card, b, a)));
    CHECK_EQ(wire(joinRecord(card, joinRecord(card, a, b), c)), wire(joinRecord(card, a, joinRecord(card, b, c))));
    CHECK_EQ(wire(joinRecord(card, a, LatticeRecord{})), wire(a));
  }
}

// §3.3's consequence: the lattice fields of any set of deltas are independent of the order they are
// joined in.
TEST(folding_any_permutation_of_deltas_gives_one_record) {
  const TypeDef& card = *probe::registry().type("card");
  Generator generator(7);
  std::mt19937_64 shuffle(8);
  for (int round = 0; round < 500; ++round) {
    std::vector<LatticeRecord> deltas;
    for (int i = 0; i < 6; ++i) deltas.push_back(generator.card());
    auto fold = [&card](const std::vector<LatticeRecord>& order) {
      LatticeRecord record;
      for (const LatticeRecord& delta : order) record = joinRecord(card, record, delta);
      return wire(record);
    };
    const std::string inOrder = fold(deltas);
    for (int permutation = 0; permutation < 5; ++permutation) {
      std::shuffle(deltas.begin(), deltas.end(), shuffle);
      CHECK_EQ(fold(deltas), inOrder);
    }
  }
}

TEST(a_ranked_register_never_falls_to_a_lower_rank) {
  Generator generator(9);
  for (int round = 0; round < 3000; ++round) {
    const std::optional<Reg> a = generator.rankedReg();
    const std::optional<Reg> b = generator.rankedReg();
    const std::optional<Reg> joined = joinRanked(a, b, tierRanks());
    for (const std::optional<Reg>& side : {a, b}) {
      if (side) CHECK(tierRanks().at(joined->value.asString()) >= tierRanks().at(side->value.asString()));
    }
  }
}

TEST(a_record_join_keeps_a_field_the_registry_does_not_know_from_its_one_side) {
  const TypeDef& card = *probe::registry().type("card");
  LatticeRecord a;
  a.f.emplace("shine", Reg{Json::Value("gold"), Stamp{4, 0, "r_a"}});
  LatticeRecord b;
  b.f.emplace("title", Reg{Json::Value("B"), Stamp{6, 0, "r_a"}});
  CHECK_EQ(wire(joinRecord(card, a, b)), std::string(R"({"f":{"shine":["gold","4:0:r_a"],"title":["B","6:0:r_a"]}})"));

  bool refused = false;
  try {
    joinRecord(card, a, a);
  } catch (const std::logic_error&) {
    refused = true;
  }
  CHECK(refused);
}
