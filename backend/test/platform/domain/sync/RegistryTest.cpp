#include "platform/domain/sync/Registry.h"

#include "platform/domain/sync/Jcs.h"

#include "products/probe/ProbeRegistry.h"
#include "products/gym/sync/GymRegistry.h"
#include "products/journal/sync/JournalRegistry.h"
#include "platform/infra/SyncProducts.h"
#include "test/testing.h"

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <functional>
#include <limits>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <stdexcept>
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

// The registries the products ship: every registry file of the contract but the test-only probe's, by file name.
std::vector<Registry> productRegistries() {
  std::vector<std::filesystem::path> files;
  for (const auto& entry : std::filesystem::directory_iterator(WM_SYNC_CONTRACT_DIR)) {
    const std::string name = entry.path().filename().string();
    if (name.ends_with(".registry.json") && name != "probe.registry.json") files.push_back(entry.path());
  }
  std::sort(files.begin(), files.end());
  std::vector<Registry> registries;
  for (const std::filesystem::path& file : files) {
    std::ifstream in(file);
    std::stringstream text;
    text << in.rdbuf();
    registries.emplace_back(parseJson(text.str()));
  }
  return registries;
}

const Domain& propertyOf(const Domain& object, const std::string& name) {
  for (const Domain::Property& property : object.properties) {
    if (property.name == name) return property.domain;
  }
  throw std::out_of_range(name);
}

}

TEST(the_probe_registry_loads_its_types_and_commands_in_order) {
  const Registry& probe = probe::registry();
  CHECK_EQ(probe.name(), std::string("probe"));
  CHECK_EQ(probe.version(), 2);
  CHECK_EQ(probe.minVersion(), 2);
  CHECK_EQ(namesOf(probe.types()), (std::vector<std::string>{"board", "card", "run", "lap", "day", "fact", "meta", "tag", "link", "mark"}));
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
  CHECK(title.kind == FieldKind::lww && title.writer == Writer::client);
  REQUIRE(title.bounds.has_value());
  CHECK(title.bounds->unit == Unit::chars);
  CHECK_EQ(title.bounds->min, std::optional<std::int64_t>(1));
  CHECK_EQ(title.bounds->max, std::optional<std::int64_t>(12));
  CHECK(title.domain->type == Domain::Type::string);

  const FieldDef& size = card->fields.at("size");
  CHECK(size.domain->type == Domain::Type::number && size.domain->nullable);
  CHECK_EQ(size.domain->min, std::optional<double>(-500));
  CHECK_EQ(size.domain->quantum->step(), 0.01);

  const FieldDef& tier = card->fields.at("tier");
  CHECK(tier.kind == FieldKind::ranked);
  CHECK_EQ(tier.rank, (std::map<std::string, std::int64_t>{{"draft", 0}, {"review", 1}, {"done", 2}, {"dropped", 2}}));

  const Domain& attachment = *card->fields.at("attachment").domain;
  CHECK(attachment.type == Domain::Type::object && attachment.nullable);
  CHECK_EQ(attachment.required, (std::vector<std::string>{"id"}));
  REQUIRE_EQ(attachment.properties.size(), 3u);
  CHECK_EQ(attachment.properties[0].name + " " + attachment.properties[1].name + " " + attachment.properties[2].name,
           std::string("id localOnly scale"));
  CHECK(attachment.properties[0].domain.pattern->matches("abcdefgh"));
  CHECK(attachment.properties[1].domain.type == Domain::Type::boolean);
  const Domain& scale = attachment.properties[2].domain;
  CHECK(scale.type == Domain::Type::number && !scale.nullable);
  CHECK_EQ(scale.min, std::optional<double>(0));
  CHECK_EQ(scale.max, std::optional<double>(10));
  CHECK_EQ(scale.quantum->step(), 0.5);
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
  CHECK_FALSE(day.wholePut);

  const TypeDef& fact = *probe.type("fact");
  CHECK(fact.identity == Identity::keyed && fact.life && fact.wholePut && fact.deadRows == DeadRows::spent);
  CHECK(fact.origins.replica && fact.origins.server);
  CHECK(fact.fields.at("value").kind == FieldKind::lww && fact.fields.at("value").writer == Writer::client);
  CHECK_EQ(fact.fields.at("value").domain->quantum->step(), 0.1);
  CHECK(fact.fields.at("at").kind == FieldKind::lww && fact.fields.at("at").domain->integer);

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
  CHECK(mark.fields.at("memo").kind == FieldKind::text && mark.fields.at("memo").bounds->unit == Unit::bytes);
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
           std::string("registry.types.item.idPattern: the pattern i_[0-9]+ is outside §2.4's portable patterns"));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["idPattern"] = "^i_[0-9+$"; }),
           std::string("registry.types.item.idPattern: the pattern ^i_[0-9+$ is outside §2.4's portable patterns"));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["minVersion"] = 3; }), std::string("registry has a minVersion above its version"));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["cap"] = 0; }),
           std::string("registry.types.item has a \"cap\" that is not an integer of at least 1"));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["fields"]["title"]["max"] = 12; }),
           std::string("registry.types.item.fields.title has a bound without a \"unit\""));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["fields"]["title"]["min"] = 1; }),
           std::string("registry.types.item.fields.title has a bound without a \"unit\""));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["fields"]["title"]["unit"] = "chars"; r["types"][0]["fields"]["title"]["max"] = 12; }),
           std::string("(admitted)"));
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

TEST(a_whole_put_is_a_keyed_type_with_life_whose_client_fields_are_lww_and_that_no_command_predicts) {
  auto withFact = [](Json::Value& r) -> Json::Value& {
    r["types"].append(parseJson(R"({"type": "fact", "scope": "product:p", "identity": "keyed", "idPattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
        "life": true, "wholePut": true, "deadRows": "spent", "origins": ["replica"],
        "fields": {"value": {"kind": "lww", "writer": "client"}, "seenBy": {"kind": "const", "writer": "server"}}})"));
    return r["types"][1];
  };
  CHECK_EQ(refusalOf([&](Json::Value& r) { withFact(r); }), std::string("(admitted)"));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["wholePut"] = true; }),
           std::string("registry.types.item is wholePut without being keyed with life"));
  CHECK_EQ(refusalOf([&](Json::Value& r) { withFact(r)["life"] = false; }),
           std::string("registry.types.fact is wholePut without being keyed with life"));
  CHECK_EQ(refusalOf([&](Json::Value& r) { withFact(r)["wholePut"] = false; }),
           std::string("registry.types.fact has a \"wholePut\" that is not true"));
  CHECK_EQ(refusalOf([&](Json::Value& r) {
             withFact(r)["fields"]["memo"] = parseJson(R"({"kind": "text", "writer": "server", "unit": "bytes", "max": 40})");
           }),
           std::string("registry.types.fact is wholePut with the text field \"memo\""));
  CHECK_EQ(refusalOf([&](Json::Value& r) { withFact(r)["fields"]["value"]["kind"] = "const"; }),
           std::string("registry.types.fact is wholePut with the client field \"value\", which is not lww"));
  CHECK_EQ(refusalOf([&](Json::Value& r) { withFact(r)["fields"]["value"]["kind"] = "fww"; }),
           std::string("registry.types.fact is wholePut with the client field \"value\", which is not lww"));
  CHECK_EQ(refusalOf([&](Json::Value& r) {
             withFact(r);
             r["commands"][0]["predicts"] = parseJson(R"(["item", "fact"])");
           }),
           std::string("registry.commands.p.sweep predicts the wholePut type \"fact\", which only deltas write"));
}

TEST(a_key_names_ids_of_other_types_and_never_leads_back_to_its_own) {
  auto keyed = [](const char* name, const char* key) {
    return parseJson(std::string(R"({"type": ")") + name + R"(", "scope": "product:p", "identity": "keyed", "key": )" + key +
                     R"(, "life": false, "origins": ["replica"], "fields": {}})");
  };
  CHECK_EQ(refusalOf([&](Json::Value& r) {
             r["types"].append(keyed("alias", R"({"ref": "alias"})"));
             r["types"][0]["fields"]["alias"] = parseJson(R"({"kind": "lww", "writer": "client", "ref": "alias", "default": "x"})");
           }),
           std::string("registry.types.alias has a key that leads back to its own type"));
  CHECK_EQ(refusalOf([&](Json::Value& r) {
             r["types"].append(keyed("left", R"({"ref": "right"})"));
             r["types"].append(keyed("right", R"({"ref": "left"})"));
           }),
           std::string("registry.types.left has a key that leads back to its own type"));
  CHECK_EQ(refusalOf([&](Json::Value& r) {
             r["types"].append(keyed("pair", R"({"tuple": [{"name": "a", "ref": "item"}, {"name": "b", "ref": "pair"}]})"));
           }),
           std::string("registry.types.pair has a key that leads back to its own type"));
  CHECK_EQ(refusalOf([&](Json::Value& r) {
             r["types"].append(keyed("alias", R"({"ref": "item"})"));
             r["types"].append(keyed("pair", R"({"tuple": [{"name": "a", "ref": "alias"}, {"name": "b", "ref": "alias"}]})"));
           }),
           std::string("(admitted)"));
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
}

TEST(a_quantum_belongs_to_a_number_domain_at_any_depth_and_never_to_a_field) {
  CHECK_EQ(refusalOf([](Json::Value& r) {
             r["types"][0]["fields"]["size"] = parseJson(R"({"kind":"lww","writer":"client","domain":{"type":"number"},"quantum":0.01})");
           }),
           std::string("registry.types.item.fields.size holds the unknown key \"quantum\""));
  CHECK_EQ(refusalOf([](Json::Value& r) {
             r["types"][0]["fields"]["title"]["domain"] = parseJson(R"({"type":"string","quantum":1})");
           }),
           std::string("registry.types.item.fields.title.domain holds the unknown key \"quantum\""));
  CHECK_EQ(refusalOf([](Json::Value& r) {
             r["types"][0]["fields"]["size"] = parseJson(R"({"kind":"lww","writer":"client","domain":{"type":"number","quantum":0.3}})");
           }),
           std::string("registry.types.item.fields.size.domain.quantum: a quantum is an integer or 1/k for an integer k"));
  CHECK_EQ(refusalOf([](Json::Value& r) {
             r["types"][0]["fields"]["size"] = parseJson(R"({"kind":"lww","writer":"client","domain":{"type":"number","quantum":0}})");
           }),
           std::string("registry.types.item.fields.size.domain.quantum: a quantum is a positive number"));
  CHECK_EQ(refusalOf([](Json::Value& r) {
             r["commands"][0]["args"]["sets"] = parseJson(
                 R"({"type":"json","domain":{"type":"array","items":{"type":"object","properties":{"kg":{"type":"number","quantum":0.3}}}}})");
           }),
           std::string("registry.commands.p.sweep.args.sets.domain.items.properties.kg.quantum: a quantum is an integer or 1/k for an integer k"));
  CHECK_EQ(refusalOf([](Json::Value& r) {
             r["types"][0]["fields"]["size"] = parseJson(R"({"kind":"lww","writer":"client","domain":{"type":"number","quantum":0.25}})");
           }),
           std::string("(admitted)"));
}

TEST(a_default_is_on_its_lattice_field_s_domain) {
  CHECK_EQ(refusalOf([](Json::Value& r) {
             r["types"][0]["fields"]["size"] = parseJson(R"({"kind":"lww","writer":"client","domain":{"type":"number","quantum":0.01},"default":1.005})");
           }),
           std::string("registry.types.item.fields.size has a default off its field's domain"));
  CHECK_EQ(refusalOf([](Json::Value& r) {
             r["types"][0]["fields"]["units"] = parseJson(R"({"kind":"lww","writer":"client","domain":{"type":"string","enum":["kg","lb"]},"default":"st"})");
           }),
           std::string("registry.types.item.fields.units has a default off its field's domain"));
  CHECK_EQ(refusalOf([](Json::Value& r) {
             r["types"][0]["fields"]["rest"] = parseJson(R"({"kind":"lww","writer":"client","domain":{"type":"number","integer":true},"default":null})");
           }),
           std::string("registry.types.item.fields.rest has a default off its field's domain"));
  CHECK_EQ(refusalOf([](Json::Value& r) {
             r["types"][0]["fields"]["title"] = parseJson(R"({"kind":"lww","writer":"client","unit":"chars","max":3,"default":"four"})");
           }),
           std::string("registry.types.item.fields.title has a default off its field's domain"));
  CHECK_EQ(refusalOf([](Json::Value& r) {
             r["types"][0]["fields"]["twin"] = parseJson(R"({"kind":"lww","writer":"client","ref":"item","default":"x_1"})");
           }),
           std::string("registry.types.item.fields.twin has a default off its field's domain"));
  CHECK_EQ(refusalOf([](Json::Value& r) {
             r["types"][0]["fields"]["state"] = parseJson(R"({"kind":"ranked","writer":"client","rank":{"a":0,"b":1},"default":"c"})");
           }),
           std::string("registry.types.item.fields.state has a default off its field's domain"));
  CHECK_EQ(refusalOf([](Json::Value& r) {
             r["types"][0]["fields"]["seen"] = parseJson(R"({"kind":"time","writer":"client","default":-1})");
           }),
           std::string("registry.types.item.fields.seen has a default off its field's domain"));
  CHECK_EQ(refusalOf([](Json::Value& r) {
             r["types"][0]["fields"]["memo"] = parseJson(R"({"kind":"text","writer":"client","unit":"bytes","max":8,"default":""})");
           }),
           std::string("registry.types.item.fields.memo has a default without being a lattice field"));
  CHECK_EQ(refusalOf([](Json::Value& r) {
             r["types"][0]["fields"]["size"] = parseJson(R"({"kind":"lww","writer":"client","domain":{"type":"number","quantum":0.01},"default":1.01})");
             r["types"][0]["fields"]["units"] = parseJson(R"({"kind":"lww","writer":"client","domain":{"type":"string","enum":["kg","lb"]},"default":"kg"})");
             r["types"][0]["fields"]["rest"] = parseJson(R"({"kind":"lww","writer":"client","domain":{"type":"number","nullable":true},"default":null})");
             r["types"][0]["fields"]["twin"] = parseJson(R"({"kind":"lww","writer":"client","ref":"item","default":"i_1"})");
             r["types"][0]["fields"]["state"] = parseJson(R"({"kind":"ranked","writer":"client","rank":{"a":0,"b":1},"default":"b"})");
           }),
           std::string("(admitted)"));
}

TEST(a_product_declares_its_own_refusal_codes_and_no_engine_code) {
  CHECK_EQ(refusalOf([](Json::Value& r) { r["products"]["p"]["codes"] = parseJson(R"(["stale"])"); }),
           std::string("registry.products.p declares the engine code \"stale\""));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["products"]["p"]["codes"] = parseJson(R"(["target-merged"])"); }),
           std::string("registry.products.p declares the engine code \"target-merged\""));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["products"]["p"]["codes"] = parseJson(R"(["Bad_Code"])"); }),
           std::string("registry.products.p has a \"codes\" item that is not a valid name"));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["products"]["p"]["codes"] = parseJson(R"(["too-soon", "too-soon"])"); }),
           std::string("registry.products.p has a \"codes\" that repeats too-soon"));
  CHECK_EQ(refusalOf([](Json::Value& r) {
             r["products"]["p"]["codes"] = parseJson(R"(["too-soon"])");
             r["products"]["q"]["codes"] = parseJson(R"(["too-late", "too-soon"])");
           }),
           std::string("registry declares the code \"too-soon\" in both p and q"));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["products"]["p"]["codes"] = parseJson(R"(["too-soon", "too-late"])"); }),
           std::string("(admitted)"));
}

TEST(a_registry_refuses_a_string_domain_bound_without_its_unit_at_any_depth) {
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["fields"]["title"]["domain"] = parseJson(R"({"type": "string", "max": 12})"); }),
           std::string("registry.types.item.fields.title.domain has a bound without a \"unit\""));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["fields"]["title"]["domain"] = parseJson(R"({"type": "string", "min": 1})"); }),
           std::string("registry.types.item.fields.title.domain has a bound without a \"unit\""));
  CHECK_EQ(refusalOf([](Json::Value& r) {
             r["types"][0]["fields"]["title"]["domain"] = parseJson(R"({"type": "array", "items": {"type": "string", "max": 12}})");
           }),
           std::string("registry.types.item.fields.title.domain.items has a bound without a \"unit\""));
  CHECK_EQ(refusalOf([](Json::Value& r) {
             r["commands"][0]["args"]["label"] = parseJson(R"({"type": "json", "domain": {"type": "object", "properties": {"name": {"type": "string", "max": 12}}}})");
           }),
           std::string("registry.commands.p.sweep.args.label.domain.properties.name has a bound without a \"unit\""));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["fields"]["title"]["domain"] = parseJson(R"({"type": "string", "unit": "bytes", "max": 12})"); }),
           std::string("(admitted)"));
}

TEST(a_registry_refuses_a_pattern_outside_section_2_4_s_portable_subset_wherever_it_sits) {
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["idPattern"] = "^i_.{12}$"; }),
           std::string("registry.types.item.idPattern: the pattern ^i_.{12}$ is outside §2.4's portable patterns"));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["types"][0]["fields"]["title"]["domain"] = parseJson(R"({"type": "string", "pattern": "^\\S+$"})"); }),
           std::string("registry.types.item.fields.title.domain.pattern: the pattern ^\\S+$ is outside §2.4's portable patterns"));
  CHECK_EQ(refusalOf([](Json::Value& r) { r["products"]["p"]["device"]["picture"] = parseJson(R"({"keyPattern": "^picture:[^/]{8,64}$"})"); }),
           std::string("registry.products.p.device.picture.keyPattern: the pattern ^picture:[^/]{8,64}$ is outside §2.4's portable patterns"));
}

TEST(a_domain_admits_a_number_only_on_its_quantum_at_any_depth) {
  const Domain& attachment = *probe::registry().type("card")->fields.at("attachment").domain;
  CHECK(attachment.admits(parseJson(R"({"id": "pic00001", "scale": 1.5})")));
  CHECK_FALSE(attachment.admits(parseJson(R"({"id": "pic00001", "scale": 1.2})")));
  CHECK(attachment.admits(parseJson(R"({"id": "pic00001"})")));

  const std::vector<Registry> registries = productRegistries();
  const Registry& gym = registries.front();
  const Domain& entries = *gym.type("routine")->fields.at("entries").domain;
  CHECK(entries.admits(parseJson(R"([{"exerciseId": "dip", "sets": [{"reps": 8, "weightKg": 60.25}, {}]}])")));
  CHECK_FALSE(entries.admits(parseJson(R"([{"exerciseId": "dip", "sets": [{"reps": 8, "weightKg": 60.25}, {"weightKg": 60.005}]}])")));

  const ArgDef& sets = gym.command("gym.importSession")->args.at("sets");
  const Json::Value onQuanta = parseJson(R"([{"id": "set00001", "exerciseId": "dip", "weightKg": 60.01, "reps": 8, "rpe": 7.5, "completedAt": 1}])");
  CHECK(gym.admitsArgument(sets, onQuanta));
  Json::Value offWeight = onQuanta;
  offWeight[0]["weightKg"] = 60.004;
  CHECK_FALSE(gym.admitsArgument(sets, offWeight));
  Json::Value offRpe = onQuanta;
  offRpe[0]["rpe"] = 7.25;
  CHECK_FALSE(gym.admitsArgument(sets, offRpe));
}

TEST(a_string_domain_measures_its_bounds_in_the_unit_it_states) {
  const Json::Value twoAccents("\xc3\xa9\xc3\xa9");  // two code points, four UTF-8 bytes
  auto stringDomain = [](const std::string& json) {
    Json::Value document = smallestRegistry();
    document["types"][0]["fields"]["title"]["domain"] = parseJson(json);
    return *Registry{document}.type("item")->field("title")->domain;
  };
  CHECK(stringDomain(R"({"type": "string", "unit": "chars", "max": 2})").admits(twoAccents));
  CHECK_FALSE(stringDomain(R"({"type": "string", "unit": "bytes", "max": 2})").admits(twoAccents));
  CHECK(stringDomain(R"({"type": "string", "unit": "bytes", "max": 4})").admits(twoAccents));
  CHECK_FALSE(stringDomain(R"({"type": "string", "unit": "chars", "min": 3})").admits(twoAccents));
}

TEST(the_product_registries_are_gym_and_journal_and_each_loads) {
  std::vector<std::string> names;
  for (const Registry& registry : productRegistries()) names.push_back(registry.name());
  CHECK_EQ(names, (std::vector<std::string>{"gym", "journal"}));
}

TEST(the_gym_registry_reads_as_declared) {
  const std::vector<Registry> registries = productRegistries();
  const Registry& gym = registries.front();
  CHECK_EQ(namesOf(gym.types()), (std::vector<std::string>{"routine", "exercise", "exerciseName", "session", "set", "note", "weighin",
                                                          "prefs", "proposal"}));
  CHECK_EQ(namesOf(gym.commands()), (std::vector<std::string>{"gym.start", "gym.importSession", "gym.correctSession", "gym.finish",
                                                             "gym.applyProposal", "gym.dismissProposal", "gym.closeStale"}));
  CHECK_EQ(gym.products().at("gym").codes, (std::vector<std::string>{"payload-conflict", "session-finished", "session-open",
                                                                    "session-overlap", "unknown-exercise", "bad-instant", "proposal-settled", "proposal-superseded"}));
  // Device rows live in `device/gym` alone (§2.5): never a wire type, never sent.
  const std::map<std::string, DeviceRowDef>& device = gym.products().at("gym").device;
  std::vector<std::string> deviceRows;
  for (const auto& [name, row] : device) deviceRows.push_back(name);
  CHECK_EQ(deviceRows, (std::vector<std::string>{"movement", "movementOrder", "offer", "rack"}));
  CHECK_EQ(gym.version(), 4);
  CHECK_EQ(gym.minVersion(), 4);
  CHECK(gym.type("thread") == nullptr);
  CHECK(gym.type("message") == nullptr);
  for (const auto& row : deviceRows) CHECK(device.at(row).keyPattern.matches(row + ":session0001"));
  for (const std::string& row : deviceRows) CHECK(gym.type(row) == nullptr);
  CHECK_EQ(gym.type("set")->fields.at("weightKg").domain->quantum->step(), 0.01);
  CHECK_EQ(gym.type("set")->fields.at("rpe").domain->quantum->step(), 0.1);
  CHECK_EQ(gym.type("weighin")->fields.at("kg").domain->quantum->step(), 0.01);
  CHECK(gym.type("weighin")->wholePut);
  CHECK_FALSE(gym.type("prefs")->wholePut);
  const Domain& entries = *gym.type("routine")->fields.at("entries").domain;
  CHECK_EQ(propertyOf(*propertyOf(*entries.items, "sets").items, "weightKg").quantum->step(), 0.01);
  for (const char* command : {"gym.importSession", "gym.correctSession"}) {
    const Domain& set = *gym.command(command)->args.at("sets").domain->items;
    CHECK_EQ(propertyOf(set, "weightKg").quantum->step(), 0.01);
    CHECK_EQ(propertyOf(set, "rpe").quantum->step(), 0.1);
  }
}

// The product registries ship as one registry: one version and minVersion, and no product, type, command or
// refusal code a second registry declares again.
TEST(the_deployment_composition_embeds_gym_and_journal_v4) {
  const Json::Value composition = parseJson(compositionText());
  CHECK_EQ(jcs(composition), jcs(parseJson(R"({"composition":"windmill","registries":["gym.registry.json","journal.registry.json"]})")));
  CHECK_EQ(productRegistry().version(), 4);
  CHECK_EQ(productRegistry().minVersion(), 4);
  const std::vector<Registry> registries{wm::gym::engine::registry(), wm::journal::engine::registry()};
  const auto catalog = productCatalog();
  CHECK_EQ(namesOf(catalog->registry().types()), (std::vector<std::string>{"routine", "exercise", "exerciseName", "session", "set", "note", "weighin", "prefs", "proposal", "page", "journalState"}));
  CHECK(catalog->registry().command("journal.savePage") != nullptr);
  CHECK(catalog->registry().command("journal.claimPage") != nullptr);
  for (const auto& type : catalog->registry().types()) CHECK_EQ(catalog->store(type.name).def().name, type.name);
  std::set<std::pair<std::int64_t, std::int64_t>> versions;
  std::vector<std::string> declared;
  for (const Registry& registry : registries) {
    versions.emplace(registry.version(), registry.minVersion());
    for (const auto& [name, product] : registry.products()) {
      declared.push_back("product " + name);
      for (const std::string& refusal : product.codes) declared.push_back("code " + refusal);
    }
    for (const std::string& name : namesOf(registry.types())) declared.push_back("type " + name);
    for (const std::string& name : namesOf(registry.commands())) declared.push_back("command " + name);
  }
  CHECK_EQ(versions.size(), 1u);
  std::sort(declared.begin(), declared.end());
  CHECK(std::adjacent_find(declared.begin(), declared.end()) == declared.end());
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
