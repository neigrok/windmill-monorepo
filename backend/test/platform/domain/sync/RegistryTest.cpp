#include "platform/domain/sync/Registry.h"

#include "platform/domain/sync/Jcs.h"

#include "products/probe/ProbeRegistry.h"
#include "test/testing.h"

#include <cmath>
#include <functional>
#include <limits>
#include <map>
#include <optional>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::sync;

namespace {

std::vector<std::string> namesOf(const auto& defs) {
  std::vector<std::string> names;
  for (const auto& def : defs) names.push_back(def.name);
  return names;
}

// The smallest registry the schema admits, for the refusal cases to break one rule at a time.
Json::Value smallestRegistry() {
  return parseJson(R"({
    "registry": "mini", "version": 2, "minVersion": 1, "products": {"p": {}},
    "types": [{"type": "item", "scope": "product:p", "identity": "minted", "idSpace": "scope",
               "idPattern": "^i_[0-9]+$", "mint": {"prefix": "i_", "alphabet": "0123456789", "length": 12},
               "life": true, "revivable": false, "deadRows": "spent",
               "origins": ["replica"], "fields": {"title": {"kind": "lww", "writer": "client"}}}],
    "commands": [{"name": "p.sweep", "scope": "product:p", "origins": ["server"], "serverInternal": true, "args": {}}]
  })");
}

std::string refusalOf(const std::function<void(Json::Value&)>& breakIt) {
  Json::Value document = smallestRegistry();
  breakIt(document);
  try {
    Registry registry{document};
  } catch (const RegistryError& error) {
    return error.what();
  }
  return "(admitted)";
}

}

TEST(the_probe_registry_loads_its_types_and_commands_in_order) {
  const Registry& probe = probe::registry();
  CHECK_EQ(probe.name(), std::string("probe"));
  CHECK_EQ(probe.version(), 1);
  CHECK_EQ(probe.minVersion(), 1);
  CHECK_EQ(namesOf(probe.types()), (std::vector<std::string>{"board", "card", "run", "lap", "day", "meta", "tag", "link", "mark"}));
  CHECK_EQ(namesOf(probe.commands()), (std::vector<std::string>{"probe.start", "probe.end", "probe.copy", "probe.tick"}));
  REQUIRE(probe.products().contains("probe"));
  CHECK_EQ(probe.products().at("probe").surfaces, (std::vector<std::string>{"web", "ios", "android"}));
  CHECK(probe.products().at("probe").device.at("picture").localOnly);
  CHECK(probe.products().at("probe").device.at("picture").keyPattern.matches("picture:abcdefgh"));
}

TEST(the_probe_card_reads_as_declared) {
  const TypeDef* card = probe::registry().type("card");
  REQUIRE(card != nullptr);
  CHECK(card->scope == (RegistryScope{ScopeKind::product, "probe"}));
  CHECK(card->identity == Identity::minted);
  CHECK(card->idSpace == IdSpace::global);
  CHECK(card->idPattern->matches("card0001"));
  CHECK_FALSE(card->idPattern->matches("c1"));
  CHECK(card->life);
  CHECK_FALSE(card->revivable);
  CHECK(card->deadRows == DeadRows::spent);
  CHECK(card->origins.replica && card->origins.server);
  CHECK_EQ(card->cap, std::optional<std::int64_t>(3));
  CHECK(card->primary);
  CHECK_FALSE(card->governsTree);

  const FieldDef& title = card->fields.at("title");
  CHECK(title.kind == FieldKind::lww && title.writer == Writer::client && title.unit == Unit::chars);
  CHECK_EQ(title.min, std::optional<std::int64_t>(1));
  CHECK_EQ(title.max, std::optional<std::int64_t>(12));
  CHECK(title.domain->type == Domain::Type::string);

  const FieldDef& size = card->fields.at("size");
  CHECK(size.domain->type == Domain::Type::number && size.domain->nullable);
  CHECK_EQ(size.domain->min, std::optional<double>(-500));
  CHECK_EQ(size.quantum->step(), 0.01);

  const FieldDef& tier = card->fields.at("tier");
  CHECK(tier.kind == FieldKind::ranked);
  CHECK_EQ(tier.rank, (std::map<std::string, std::int64_t>{{"draft", 0}, {"review", 1}, {"done", 2}, {"dropped", 2}}));

  const Domain& attachment = *card->fields.at("attachment").domain;
  CHECK(attachment.type == Domain::Type::object && attachment.nullable);
  CHECK_EQ(attachment.required, (std::vector<std::string>{"id"}));
  REQUIRE_EQ(attachment.properties.size(), 2u);
  CHECK_EQ(attachment.properties[0].name, std::string("id"));
  CHECK(attachment.properties[0].domain.pattern->matches("abcdefgh"));
  CHECK(attachment.properties[1].domain.type == Domain::Type::boolean);
}

TEST(the_probe_types_carry_every_identity_class) {
  const Registry& probe = probe::registry();
  CHECK(probe.type("board")->governsTree);
  CHECK(probe.type("board")->deadRows == DeadRows::keep);
  CHECK_EQ(probe.type("board")->mint->prefix + probe.type("board")->mint->alphabet, std::string("b_0123456789abcdef"));
  CHECK_EQ(probe.type("board")->mint->length, 8);

  const TypeDef& day = *probe.type("day");
  CHECK(day.identity == Identity::keyed && day.life && day.deadRows == DeadRows::spent);
  CHECK(day.idPattern->matches("2026-09-27"));
  CHECK_FALSE(day.mint.has_value());

  const TypeDef& lap = *probe.type("lap");
  CHECK_EQ(lap.seeded->seedMax, 58);
  CHECK_EQ(lap.seeded->ordinalMax, 99999);
  CHECK(lap.fields.at("runId").kind == FieldKind::const_ && lap.fields.at("runId").parent);
  CHECK_EQ(lap.fields.at("runId").ref, std::optional<std::string>("run"));
  CHECK(lap.fields.at("no").kind == FieldKind::serial && lap.fields.at("no").writer == Writer::server);
  CHECK_EQ(lap.fields.at("no").serialNext, (std::vector<std::string>{"runId"}));
  CHECK_FALSE(lap.fields.at("no").isLattice());

  const TypeDef& meta = *probe.type("meta");
  CHECK(meta.identity == Identity::singleton && meta.scope.kind == ScopeKind::tree);
  CHECK_EQ(meta.singletonId, std::optional<std::string>("meta"));
  CHECK_EQ(meta.fields.at("visibility").domain->oneOf, (std::vector<std::string>{"private", "unlisted", "public"}));
  CHECK_EQ(meta.fields.at("visibility").opens, (std::vector<std::string>{"unlisted", "public"}));

  const TypeDef& tag = *probe.type("tag");
  CHECK(tag.identity == Identity::derived && tag.revivable && tag.idSpace == IdSpace::scope);
  CHECK_EQ(tag.deriveFallback, std::optional<std::string>("tag"));

  const TypeDef& link = *probe.type("link");
  REQUIRE_EQ(link.keyTuple.size(), 2u);
  CHECK_EQ(link.keyTuple[0].name + ":" + link.keyTuple[0].ref + " " + link.keyTuple[1].name + ":" + link.keyTuple[1].ref,
           std::string("from:tag to:tag"));
  CHECK_FALSE(link.idPattern.has_value());

  const TypeDef& mark = *probe.type("mark");
  CHECK(mark.scope.kind == ScopeKind::overlay && !mark.life);
  CHECK_EQ(mark.keyRef, std::optional<std::string>("tag"));
  CHECK_EQ(mark.visibleWhen, (std::vector<std::string>{"done", "memo"}));
  CHECK(mark.fields.at("memo").kind == FieldKind::text && mark.fields.at("memo").unit == Unit::bytes);
  CHECK(mark.origins.replica && !mark.origins.server);
}

TEST(the_probe_commands_read_as_declared) {
  const CommandDef& start = *probe::registry().command("probe.start");
  CHECK(start.origins.replica && start.origins.server && !start.serverInternal);
  CHECK(start.args.at("id").type == ArgType::ref);
  CHECK_EQ(start.args.at("id").ref, std::optional<std::string>("run"));
  CHECK(start.args.at("label").optional && start.args.at("label").domain->nullable);
  CHECK(start.args.at("startedAt").type == ArgType::time);
  CHECK(start.args.at("join").domain->type == Domain::Type::boolean);
  CHECK_EQ(start.predicts, (std::vector<std::string>{"run"}));

  CHECK(!start.beforePull);

  CHECK(probe::registry().command("probe.end")->args.at("endedAt").type == ArgType::instant);
  CHECK_EQ(probe::registry().command("probe.copy")->args.at("dst").ref, std::optional<std::string>("board"));
  const CommandDef& tick = *probe::registry().command("probe.tick");
  CHECK(tick.serverInternal && tick.beforePull && !tick.origins.replica && tick.args.empty());
}

TEST(the_smallest_registry_is_admitted) {
  CHECK_EQ(refusalOf([](Json::Value&) {}), std::string("(admitted)"));
}

TEST(a_registry_refuses_a_document_the_schema_refuses) {
  CHECK_EQ(refusalOf([](Json::Value& r) { r["extra"] = 1; }), std::string("registry holds the unknown key \"extra\""));
  CHECK_EQ(refusalOf([](Json::Value& r) { r.removeMember("commands"); }), std::string("registry lacks \"commands\""));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0].removeMember("fields"); }),
           std::string("registry.types.item lacks \"fields\""));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["fields"]["title"]["kind"] = "set"; }),
           std::string("registry.types.item.fields.title has a \"kind\" outside its enumeration: set"));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["idPattern"] = "i_[0-9]+"; }),
           std::string("registry.types.item.idPattern: the pattern i_[0-9]+ is not anchored with ^ and $"));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["idPattern"] = "^i_[0-9+$"; }),
           std::string("registry.types.item.idPattern: the pattern ^i_[0-9+$ does not compile"));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["minVersion"] = 3; }), std::string("registry has a minVersion above its version"));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["cap"] = 0; }),
           std::string("registry.types.item has a \"cap\" that is not an integer of at least 1"));
}

TEST(a_registry_refuses_what_section_2_4_forbids) {
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"].append(r["types"][0]); }),
           std::string("registry declares the type \"item\" twice"));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["fields"]["owner"] = parseJson(R"({"kind":"lww","writer":"client","ref":"ghost"})"); }),
           std::string("registry.types.item.fields.owner refers to the unknown type \"ghost\""));
  CHECK_EQ(refusalOf([](Json::Value& r) {
             r["types"][0]["fields"]["a"] = parseJson(R"({"kind":"const","writer":"client","ref":"item","parent":true})");
             r["types"][0]["fields"]["b"] = parseJson(R"({"kind":"const","writer":"client","ref":"item","parent":true})");
           }),
           std::string("registry.types.item has more than one parent field"));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["revivable"] = true; }),
           std::string("registry.types.item is revivable without keeping its dead rows"));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["origins"] = parseJson(R"(["server"])"); }),
           std::string("registry.types.item has origins without replica"));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["scope"] = "product:q"; }),
           std::string("registry.types.item lives in the undeclared product \"q\""));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["scope"] = "tree"; r["types"][0]["governs"] = "tree"; }),
           std::string("registry.types.item governs a tree without being a terminal minted type of a product scope in the global id space"));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["governs"] = "tree"; }),
           std::string("registry.types.item governs a tree without being a terminal minted type of a product scope in the global id space"));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["life"] = false; }),
           std::string("registry.types.item is minted or derived without life"));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["commands"][0]["origins"].append("replica"); }),
           std::string("registry.commands.p.sweep is server-internal with a replica origin"));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["commands"][0]["serverInternal"] = false; r["commands"][0]["beforePull"] = true; }),
           std::string("registry.commands.p.sweep runs before pulls without being server-internal"));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0].removeMember("mint"); }),
           std::string("registry.types.item is minted or derived without \"idSpace\", \"idPattern\", \"revivable\", \"deadRows\" and \"mint\""));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["mint"]["alphabet"] = "0123456789abcdef"; }),
           std::string("registry.types.item mints ids its idPattern refuses"));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["fields"]["seen"] = parseJson(R"({"kind":"lww","writer":"server","opens":["yes"]})"); }),
           std::string("registry.types.item opens a tree from \"seen\", which is not a field of a tree singleton"));
}

TEST(a_registry_refuses_a_field_its_kind_cannot_hold) {
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["fields"]["state"] = parseJson(R"({"kind":"ranked","writer":"client"})"); }),
           std::string("registry.types.item.fields.state is ranked without a \"rank\""));
  CHECK_EQ(refusalOf([](Json::Value& r) {
             r["types"][0]["fields"]["state"] = parseJson(
                 R"({"kind":"ranked","writer":"client","rank":{"a":0,"b":1},"domain":{"type":"string","enum":["a","c"]}})");
           }),
           std::string("registry.types.item.fields.state ranks values other than its domain's"));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["fields"]["no"] = parseJson(R"({"kind":"serial","writer":"client","serialNext":[]})"); }),
           std::string("registry.types.item.fields.no is serial without \"serialNext\" and the server as its writer"));
  CHECK_EQ(refusalOf([](Json::Value& r) {
             r["types"][0]["fields"]["no"] = parseJson(R"({"kind":"serial","writer":"server","serialNext":["ghost"]})");
           }),
           std::string("registry.types.item numbers \"no\" after the unknown field \"ghost\""));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["fields"]["memo"] = parseJson(R"({"kind":"text","writer":"client"})"); }),
           std::string("registry.types.item.fields.memo is text without a \"unit\" and a \"max\""));
  CHECK_EQ(refusalOf([](Json::Value& r) {
             r["types"][0]["fields"]["size"] = parseJson(R"({"kind":"lww","writer":"client","domain":{"type":"number"},"quantum":0.3})");
           }),
           std::string("registry.types.item.fields.size.quantum: a quantum is an integer or 1/k for an integer k"));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["fields"]["size"] = parseJson(R"({"kind":"lww","writer":"client","quantum":0.5})"); }),
           std::string("registry.types.item.fields.size has a quantum without a number domain"));
}

// SPEC-GAP 12: roundHalfAway(x × k) ÷ k for q = 1/k, roundHalfAway(x ÷ q) × q for an integer q, in doubles.
TEST(a_quantum_rounds_half_away_from_zero_in_doubles) {
  const Quantum cents{0.01};
  CHECK_EQ(cents.round(1.005), 1.0);     // 1.005 × 100 is 100.49999999999999 in doubles
  CHECK_EQ(cents.round(10.235), 10.24);
  CHECK_EQ(cents.round(-2.675), -2.68);
  CHECK_EQ(cents.round(0.125), 0.13);
  CHECK_EQ(cents.round(-0.001), 0.0);
  CHECK(!std::signbit(cents.round(-0.001)));   // never -0
  CHECK(cents.holds(10.24));
  CHECK_FALSE(cents.holds(10.235));
  CHECK_FALSE(cents.holds(1.005));

  const Quantum halves{0.5};
  CHECK_EQ(halves.round(1.25), 1.5);
  CHECK_EQ(halves.round(-1.25), -1.5);
  CHECK(halves.holds(2.5));

  const Quantum fives{5};
  CHECK_EQ(fives.round(12.5), 15.0);
  CHECK_EQ(fives.round(-12.5), -15.0);
  CHECK_EQ(fives.round(12.4), 10.0);
  CHECK(fives.holds(15));
  CHECK_FALSE(fives.holds(12));
}

TEST(a_quantum_is_an_integer_or_the_inverse_of_one) {
  for (const double step : {0.0, -1.0, 0.3, 0.75, 1.5, std::numeric_limits<double>::infinity()}) {
    bool refused = false;
    try {
      Quantum{step};
    } catch (const RegistryError&) {
      refused = true;
    }
    CHECK(refused);
  }
}
