#include "platform/domain/sync/FractionalIndex.h"
#include "products/roadmap/adoption/Adoption.h"
#include "products/roadmap/adoption/Audit.h"
#include "products/roadmap/application/RoadmapRows.h"
#include "test/testing.h"

#include <algorithm>
#include <map>
#include <string>
#include <tuple>
#include <vector>

using namespace wm;
using namespace wm::roadmap;
using namespace wm::roadmap::adoption;

namespace {

constexpr sync::Ms kNow = 1'760'000'000'000;

Hlc stamp(std::uint64_t ms, std::uint32_t counter, const char* actor) { return Hlc{ms, counter, actor}; }

OldRegister held(const char* value, const char* at) { return OldRegister{Json::Value(value), at}; }

OldStep step(const char* id, const char* added, const char* ord = "", const char* removed = "") {
  OldStep step{.id = id, .added = added, .removed = removed};
  step.label = held(id, added);
  step.color = held("terracotta", "");
  step.ord = held(ord, added);
  step.links = OldRegister{Json::Value(Json::arrayValue), ""};
  return step;
}

OldRoadmap root(const char* id, std::optional<std::string> owner) {
  return OldRoadmap{.id = id, .owner = std::move(owner), .title = held("A roadmap", ""), .guide = held("", ""), .visibility = "public",
                    .createdAt = 1'700'000'000'000, .updatedAt = 1'750'000'000'000, .root = id};
}

const sync::Row* rowOf(const ScopePlan& scope, const std::string& type, const std::string& id) {
  for (const sync::Row& row : scope.rows)
    if (row.t == type && row.id.column() == id) return &row;
  return nullptr;
}

const RoadmapPlan* planOf(const Plan& plan, const std::string& id) {
  for (const OwnerPlan& owner : plan.owners)
    for (const RoadmapPlan& roadmap : owner.roadmaps)
      if (roadmap.id == id) return &roadmap;
  return nullptr;
}

}

TEST(a_stamp_is_kept_where_the_engine_would_write_it_and_otherwise_takes_the_lowest_server_stamp) {
  CHECK(readStamp("1740000000000:3:r_owner", kNow).state == StampState::kept);
  CHECK(readStamp("1740000000000:3:r_owner", kNow).stamp == stamp(1740000000000, 3, "r_owner"));
  CHECK(readStamp("", kNow).state == StampState::unset);
  CHECK(readStamp("0:0:", kNow).state == StampState::unset);
  CHECK(!readStamp("0:0:", kNow).set());
  for (const char* malformed : {"not a stamp", "01:0:r_owner", "1740000000000:4:", "1740000000000:4", "x1:0:r", "17:-1:r"}) {
    CHECK(readStamp(malformed, kNow).state == StampState::malformed);
    CHECK(readStamp(malformed, kNow).stamp == kLowestServerStamp);
  }
  CHECK(readStamp(std::to_string(kNow + kMaxSkewMs) + ":0:r_owner", kNow).state == StampState::kept);
  CHECK(readStamp(std::to_string(kNow + kMaxSkewMs + 1) + ":0:r_owner", kNow).state == StampState::future);
  CHECK(readStamp("9999999999999:0:r_owner", kNow).stamp == kLowestServerStamp);
  CHECK(kLowestServerStamp > Hlc{});
  CHECK(kLowestServerStamp < stamp(1, 0, "a"));
}

TEST(life_is_alive_while_the_add_stamp_is_set_and_not_older_than_the_remove_stamp) {
  const auto read = [](const char* text) { return readStamp(text, kNow); };
  const std::optional<AdoptedLife> added = lifeOf(read("5:0:a"), read(""));
  REQUIRE(added.has_value());
  CHECK(added->life.alive());
  CHECK(added->life.stamp == stamp(5, 0, "a"));
  CHECK(added->born == stamp(5, 0, "a"));

  const std::optional<AdoptedLife> removed = lifeOf(read("5:0:a"), read("6:0:a"));
  REQUIRE(removed.has_value());
  CHECK_FALSE(removed->life.alive());
  CHECK(removed->life.stamp == stamp(6, 0, "a"));
  CHECK(removed->born == stamp(5, 0, "a"));

  const std::optional<AdoptedLife> revived = lifeOf(read("7:0:a"), read("6:0:a"));
  REQUIRE(revived.has_value());
  CHECK(revived->life.alive());
  CHECK(revived->life.stamp == stamp(7, 0, "a"));

  const std::optional<AdoptedLife> tie = lifeOf(read("6:0:a"), read("6:0:a"));
  REQUIRE(tie.has_value());
  CHECK(tie->life.alive());

  const std::optional<AdoptedLife> removedOnly = lifeOf(read(""), read("6:0:a"));
  REQUIRE(removedOnly.has_value());
  CHECK_FALSE(removedOnly->life.alive());
  CHECK(removedOnly->born == kLowestServerStamp);

  const std::optional<AdoptedLife> malformed = lifeOf(read("garbage"), read(""));
  REQUIRE(malformed.has_value());
  CHECK(malformed->life.alive());
  CHECK(malformed->born == kLowestServerStamp);

  CHECK_FALSE(lifeOf(read(""), read("0:0:")).has_value());
}

TEST(empty_and_malformed_order_keys_become_keys_in_their_place_in_todays_order) {
  const std::vector<OrderedStep> steps{
      {"late-empty", "", stamp(9, 0, "a")},  {"early-empty", "", stamp(2, 0, "a")}, {"b", "a1", stamp(1, 0, "a")},
      {"a", "a0", stamp(1, 0, "a")},         {"twin", "a1", stamp(0, 5, "a")},      {"between", "a0~", stamp(3, 0, "a")},
      {"after-all", "zz!", stamp(4, 0, "a")}, {"also-between", "a0~", stamp(1, 0, "a")}};
  const std::map<std::string, std::string> keys = stepKeys(steps);
  CHECK_EQ(keys.at("a"), std::string("a0"));
  CHECK_EQ(keys.at("b"), std::string("a1"));
  CHECK_EQ(keys.at("twin"), std::string("a1"));
  for (const auto& [id, key] : keys) CHECK(sync::isOrderKey(key));

  std::vector<OrderedStep> today = steps;
  std::sort(today.begin(), today.end(), [](const OrderedStep& x, const OrderedStep& y) { return std::tie(x.ord, x.created, x.id) < std::tie(y.ord, y.created, y.id); });
  std::vector<OrderedStep> adopted = steps;
  std::sort(adopted.begin(), adopted.end(), [&](const OrderedStep& x, const OrderedStep& y) {
    return std::tie(keys.at(x.id), x.created, x.id) < std::tie(keys.at(y.id), y.created, y.id);
  });
  std::vector<std::string> todayIds;
  std::vector<std::string> adoptedIds;
  for (const OrderedStep& each : today) todayIds.push_back(each.id);
  for (const OrderedStep& each : adopted) adoptedIds.push_back(each.id);
  CHECK(todayIds == adoptedIds);
  CHECK(todayIds == (std::vector<std::string>{"early-empty", "late-empty", "a", "also-between", "between", "twin", "b", "after-all"}));
}

TEST(kinds_take_keys_in_rank_order_then_id) {
  std::vector<OldKind> kinds(3);
  kinds[0] = OldKind{.id = "build"};
  kinds[0].rank = OldRegister{Json::Value(1.0), ""};
  kinds[1] = OldKind{.id = "learn"};
  kinds[1].rank = OldRegister{Json::Value(0.0), ""};
  kinds[2] = OldKind{.id = "also"};
  kinds[2].rank = OldRegister{Json::Value(1.0), ""};
  const std::map<std::string, std::string> keys = kindKeys(kinds);
  CHECK_EQ(keys.at("learn"), std::string("a0"));
  CHECK_EQ(keys.at("also"), std::string("a1"));
  CHECK_EQ(keys.at("build"), std::string("a2"));
}

TEST(a_roadmap_with_no_owner_stops_the_move_unless_it_is_expected_and_then_the_house_account_owns_it) {
  OldDatabase database{.roadmaps = {root("t_0000000000000001", std::nullopt), root("t_0000000000000002", "gone")}, .accounts = {}};
  const Survey unexpected(database, Expectation{{}, kNow});
  CHECK(unexpected.stopped());
  CHECK_EQ(unexpected.stops()["stop.unexpectedOwnerlessRoadmap"], 2u);
  CHECK(plan(unexpected).owners.empty());

  const Survey expected(database, Expectation{{"t_0000000000000001", "t_0000000000000002"}, kNow});
  CHECK_FALSE(expected.stopped());
  CHECK(expected.roadmaps().at("t_0000000000000001").owner == kHouseAccount);
  CHECK(expected.roadmaps().at("t_0000000000000002").owner == kHouseAccount);
  const Plan planned = plan(expected);
  REQUIRE_EQ(planned.owners.size(), 1u);
  CHECK(planned.owners[0].owner == kHouseAccount);
  CHECK_EQ(planned.owners[0].roadmaps.size(), 2u);
}

TEST(a_status_outside_the_four_and_a_place_that_does_not_follow_from_its_parent_stop_the_move) {
  OldRoadmap cello = root("t_0000000000000001", "owner");
  cello.steps.push_back(step("bow", "5:0:a"));
  cello.steps.back().status = held("banana", "5:0:a");
  OldRoadmap orphan = root("t_0000000000000002", "owner");
  orphan.parent = read::Parent{"t_00000000000000ff", "bow"};
  orphan.root = "t_00000000000000ff";
  orphan.depth = 1;
  OldRoadmap astray = root("t_0000000000000003", "owner");
  astray.parent = read::Parent{"t_0000000000000001", "bow"};
  astray.root = "t_0000000000000001";
  astray.depth = 2;
  const Survey survey(OldDatabase{.roadmaps = {cello, orphan, astray}, .accounts = {"owner"}}, Expectation{{}, kNow});
  CHECK_EQ(survey.stops()["stop.unknownStepStatus"], 1u);
  CHECK_EQ(survey.stops()["stop.subtreeOfAMissingRoadmap"], 1u);
  CHECK_EQ(survey.stops()["stop.placeDisagreesWithItsParent"], 1u);
  const std::vector<std::pair<std::string, std::string>> stoppedBy{{"t_0000000000000001", "stop.unknownStepStatus"},
                                                                   {"t_0000000000000002", "stop.subtreeOfAMissingRoadmap"},
                                                                   {"t_0000000000000003", "stop.placeDisagreesWithItsParent"}};
  std::vector<std::pair<std::string, std::string>> found = survey.stoppedBy();
  std::sort(found.begin(), found.end());
  CHECK(found == stoppedBy);
}

TEST(the_plan_numbers_a_tree_scope_above_its_head_and_writes_each_register_by_its_stamp) {
  OldRoadmap cello = root("t_0000000000000001", "owner");
  cello.head = 9;
  cello.title = held("Learn the cello", "");
  cello.guide = held("", "");
  cello.steps.push_back(step("bow", "1740000000000:1:a", "a1"));
  cello.steps.back().label = held("Hold the bow", "not a stamp");
  cello.steps.back().icon = held("", "");
  cello.steps.back().description = held("Thumb bent", "");
  cello.steps.push_back(step("tune", "1740000000000:2:a"));
  cello.steps.back().label = held("Tune", "1760000000000:0:a");
  const Survey survey(OldDatabase{.roadmaps = {cello}, .accounts = {"owner"}}, Expectation{{}, kNow});
  const Plan planned = plan(survey);
  const RoadmapPlan* roadmap = planOf(planned, "t_0000000000000001");
  REQUIRE(roadmap != nullptr);
  const ScopePlan& tree = roadmap->tree;
  CHECK_EQ(tree.key.text(), std::string("tree:t_0000000000000001"));
  CHECK_EQ(*tree.governedBy, std::string("acct:owner/roadmap#tree#t_0000000000000001"));
  REQUIRE_EQ(tree.rows.size(), 3u);
  CHECK_EQ(tree.rows[0].t, std::string("meta"));
  CHECK_EQ(tree.rows[0].seq, 10u);
  CHECK_EQ(tree.rows[1].id.column(), std::string("bow"));
  CHECK_EQ(tree.rows[2].id.column(), std::string("tune"));
  CHECK_EQ(tree.seq, 12u);
  CHECK_EQ(tree.counters.at("node"), 2);
  CHECK(tree.open);
  std::vector<Json::Value> hashed;
  for (const sync::Row& row : tree.rows) hashed.push_back(row.toJson());
  CHECK(tree.digest == sync::scopeDigest(hashed));

  const sync::Row& meta = tree.rows[0];
  CHECK(meta.lattice.f.at("title").value == Json::Value("Learn the cello"));
  CHECK(meta.lattice.f.at("title").stamp == kLowestServerStamp);
  CHECK_FALSE(meta.lattice.f.contains("guide"));
  CHECK(meta.lattice.f.at("visibility").stamp == kLowestServerStamp);
  CHECK(meta.lattice.f.at("reach").value == Json::Value("public"));
  CHECK_FALSE(meta.lattice.f.contains("root"));
  CHECK(meta.rc == 1'700'000'000'000u);
  CHECK(meta.ru == 1'750'000'000'000u);

  const sync::Row& bow = tree.rows[1];
  CHECK(bow.lattice.f.at("label").stamp == kLowestServerStamp);
  CHECK(bow.lattice.f.at("description").value == Json::Value("Thumb bent"));
  CHECK(bow.lattice.f.at("description").stamp == kLowestServerStamp);
  CHECK_FALSE(bow.lattice.f.contains("icon"));
  CHECK_FALSE(bow.lattice.f.contains("color"));
  CHECK(bow.lattice.f.at("ord").value == Json::Value("a1"));
  CHECK(bow.lattice.born == stamp(1740000000000, 1, "a"));
  CHECK(bow.rc == 1740000000000u);
  const sync::Row& tune = tree.rows[2];
  CHECK(tune.lattice.f.at("label").stamp == stamp(1760000000000, 0, "a"));
  CHECK(tune.ru == 1'750'000'000'000u);
  CHECK(sync::isOrderKey(tune.lattice.f.at("ord").value.asString()));
  CHECK(tune.lattice.f.at("ord").value.asString() < "a1");

  CHECK_EQ(roadmap->record.t, std::string("tree"));
  CHECK(roadmap->record.alive());
  CHECK(roadmap->record.lattice.born == kLowestServerStamp);
  CHECK_FALSE(roadmap->record.lattice.f.contains("parent"));
}

TEST(a_deleted_roadmap_and_every_subtree_under_it_are_adopted_as_spent_ids_with_their_tree_scopes_dead) {
  OldRoadmap gone = root("t_0000000000000001", "owner");
  gone.steps.push_back(step("owning", "5:0:a"));
  gone.deletedAt = 1'745'000'000'000;
  OldRoadmap below = root("t_0000000000000002", "owner");
  below.parent = read::Parent{"t_0000000000000001", "owning"};
  below.root = "t_0000000000000001";
  below.depth = 1;
  below.steps.push_back(step("below", "6:0:a"));
  const Survey survey(OldDatabase{.roadmaps = {gone, below}, .accounts = {"owner"}}, Expectation{{}, kNow});
  CHECK_EQ(survey.tally()["notAdopted.deletedRoadmaps"], 2u);
  const Plan planned = plan(survey);
  for (const char* id : {"t_0000000000000001", "t_0000000000000002"}) {
    const RoadmapPlan* roadmap = planOf(planned, id);
    REQUIRE(roadmap != nullptr);
    CHECK_FALSE(roadmap->record.alive());
    CHECK(roadmap->record.lattice.f.empty());
    CHECK(roadmap->tree.deadAt == std::optional<sync::Ms>(1'745'000'000'000));
    CHECK(roadmap->tree.rows.empty());
    CHECK(roadmap->overlays.empty());
  }
  CHECK(documentsBefore(survey).empty());
}

TEST(a_subtree_is_read_by_whoever_may_read_its_root_while_every_owning_step_on_its_way_down_is_present) {
  OldRoadmap cello = root("t_0000000000000001", "owner");
  cello.visibility = "unlisted";
  cello.steps.push_back(step("strings", "5:0:a"));
  cello.steps.push_back(step("dropped", "5:1:a", "", "6:0:a"));
  OldRoadmap standing = root("t_0000000000000002", "owner");
  standing.parent = read::Parent{"t_0000000000000001", "strings"};
  standing.root = "t_0000000000000001";
  standing.depth = 1;
  standing.visibility = "private";
  OldRoadmap hidden = root("t_0000000000000003", "owner");
  hidden.parent = read::Parent{"t_0000000000000001", "dropped"};
  hidden.root = "t_0000000000000001";
  hidden.depth = 1;
  hidden.visibility = "private";
  const Survey survey(OldDatabase{.roadmaps = {cello, standing, hidden}, .accounts = {"owner"}}, Expectation{{}, kNow});
  CHECK(survey.roadmaps().at("t_0000000000000002").stands);
  CHECK_EQ(survey.roadmaps().at("t_0000000000000002").reach, std::string("unlisted"));
  CHECK_FALSE(survey.roadmaps().at("t_0000000000000003").stands);
  CHECK_EQ(survey.roadmaps().at("t_0000000000000003").reach, std::string("private"));
  const Plan planned = plan(survey);
  const RoadmapPlan* subtree = planOf(planned, "t_0000000000000002");
  REQUIRE(subtree != nullptr);
  const sync::Row* meta = rowOf(subtree->tree, "meta", "meta");
  REQUIRE(meta != nullptr);
  CHECK(meta->lattice.f.at("root").value == Json::Value("t_0000000000000001"));
  CHECK(meta->lattice.f.at("depth").value == Json::Value(Json::Int64(1)));
  CHECK_FALSE(meta->lattice.f.contains("visibility"));
  CHECK(subtree->record.lattice.f.at("parent").value["step"] == Json::Value("strings"));
  const sync::Row* strings = rowOf(planOf(planned, "t_0000000000000001")->tree, "node", "strings");
  REQUIRE(strings != nullptr);
  CHECK(strings->lattice.f.at("branch").value == Json::Value("t_0000000000000002"));
}

TEST(marks_move_to_their_owners_overlays_and_a_pointer_to_the_owners_while_a_mark_of_no_account_stays_behind) {
  OldRoadmap cello = root("t_0000000000000001", "owner");
  cello.steps.push_back(step("bow", "5:0:a"));
  cello.steps.back().opens = held("t_0000000000000009", "7:0:a");
  cello.marks.push_back(OldMark{"owner", "bow", "complete", true, "8:0:a", 1'741'000'000'000});
  cello.marks.push_back(OldMark{"reader", "bow", "inProgress", false, "", 1'741'000'000'001});
  cello.marks.push_back(OldMark{"dev", "bow", "complete", false, "9:0:dev", 1'741'000'000'002});
  const Survey survey(OldDatabase{.roadmaps = {cello}, .accounts = {"owner", "reader"}}, Expectation{{}, kNow});
  const Plan planned = plan(survey);
  CHECK_EQ(planned.tally["notAdopted.marksOfNoAccount"], 1u);
  const RoadmapPlan* roadmap = planOf(planned, "t_0000000000000001");
  REQUIRE(roadmap != nullptr);
  REQUIRE_EQ(roadmap->overlays.size(), 2u);
  const ScopePlan& owners = roadmap->overlays[0];
  CHECK_EQ(owners.key.text(), std::string("acct:owner/overlay/t_0000000000000001"));
  CHECK_EQ(*owners.governedBy, std::string("tree:t_0000000000000001"));
  REQUIRE_EQ(owners.rows.size(), 2u);
  CHECK_EQ(owners.rows[0].t, std::string("progress"));
  CHECK(owners.rows[0].lattice.f.at("mark").value["outOfOrder"] == Json::Value(true));
  CHECK(owners.rows[0].rc == 1'741'000'000'000u);
  CHECK_EQ(owners.rows[1].t, std::string("pointer"));
  CHECK(owners.rows[1].lattice.f.at("opens").value == Json::Value("t_0000000000000009"));
  CHECK(owners.rows[1].lattice.life->stamp == stamp(7, 0, "a"));
  const ScopePlan& readers = roadmap->overlays[1];
  CHECK_EQ(readers.key.text(), std::string("acct:reader/overlay/t_0000000000000001"));
  REQUIRE_EQ(readers.rows.size(), 1u);
  CHECK(readers.rows[0].lattice.f.at("mark").value["status"] == Json::Value("none"));
  CHECK(readers.rows[0].lattice.f.at("mark").stamp == kLowestServerStamp);
}

TEST(the_engines_reading_of_the_planned_rows_gives_the_old_servers_document_of_every_roadmap) {
  OldRoadmap cello = root("t_0000000000000001", "owner");
  cello.guide = held("Practise daily", "4:0:a");
  cello.guideInherited = true;
  cello.forkedFrom = "t_00000000000000aa";
  cello.steps.push_back(step("strings", "5:0:a", "a0"));
  cello.steps.push_back(step("bow", "5:1:a"));
  cello.steps.back().color = held("mauve", "5:1:a");
  cello.steps.back().status = held("active", "5:1:a");
  cello.steps.back().links = OldRegister{Json::Value(Json::arrayValue), "5:1:a"};
  cello.steps.back().links.value.append(Json::Value(Json::objectValue));
  cello.steps.back().links.value[0]["url"] = "https://example.com";
  cello.steps.back().links.value[0]["label"] = "";
  cello.steps.back().opens = held("t_0000000000000003", "5:2:a");
  cello.steps.push_back(step("gone", "5:2:a", "a5", "6:0:a"));
  cello.steps.push_back(step("ghost", "", "a6"));
  cello.links = {OldLink{"strings", "bow", "7:0:a", ""}, OldLink{"bow", "bow", "7:1:a", ""}, OldLink{"bow", "nowhere", "7:2:a", ""},
                 OldLink{"strings", "gone", "7:3:a", "8:0:a"}};
  cello.kinds.resize(2);
  cello.kinds[0] = OldKind{.id = "build", .added = "3:0:a", .hue = held("terracotta", "3:0:a"), .label = held("Build", "3:0:a"),
                           .description = held("", ""), .rank = OldRegister{Json::Value(1.0), "3:0:a"}};
  cello.kinds[1] = OldKind{.id = "learn", .added = "3:0:a", .removed = "3:1:a", .hue = held("olive", "3:0:a"),
                           .label = held("Learn", "3:0:a"), .description = held("", ""), .rank = OldRegister{Json::Value(0.0), ""}};
  cello.marks.push_back(OldMark{"owner", "strings", "complete", false, "9:0:a", 1'741'000'000'000});
  cello.marks.push_back(OldMark{"reader", "bow", "complete", true, "bad", 1'741'000'000'001});
  OldRoadmap subtree = root("t_0000000000000002", "owner");
  subtree.parent = read::Parent{"t_0000000000000001", "strings"};
  subtree.root = "t_0000000000000001";
  subtree.depth = 1;
  subtree.title = held("", "");
  subtree.steps.push_back(step("open-strings", "5:3:a"));
  OldRoadmap music = root("t_0000000000000003", "owner");
  music.visibility = "private";
  const Survey survey(OldDatabase{.roadmaps = {cello, subtree, music}, .accounts = {"owner", "reader"}}, Expectation{{}, kNow});
  REQUIRE(!survey.stopped());
  const Plan planned = plan(survey);
  REQUIRE_EQ(planned.owners.size(), 1u);

  AccountRows account{UserId{"owner"}, {}};
  for (const RoadmapPlan& roadmap : planned.owners[0].roadmaps) account.trees.emplace(roadmap.id, roadmap.record);
  std::vector<EngineRoadmap> engine;
  for (const RoadmapPlan& roadmap : planned.owners[0].roadmaps) {
    TreeRows rows;
    rows.tree = roadmap.id;
    rows.scope = sync::ScopeRow{.key = roadmap.tree.key, .owner = roadmap.tree.owner};
    for (const sync::Row& row : roadmap.tree.rows) {
      if (row.t == "meta") rows.meta = row;
      if (row.t == "node") rows.nodes.push_back(row);
      if (row.t == "edge") rows.edges.push_back(row);
      if (row.t == "kind") rows.kinds.push_back(row);
    }
    EngineRoadmap read{.owner = roadmap.tree.owner.str()};
    for (const ScopePlan& overlay : roadmap.overlays) {
      for (const sync::Row& row : overlay.rows) {
        if (row.t == "pointer") rows.pointers.push_back(row);
        if (row.t == "progress" && overlay.owner == roadmap.tree.owner) rows.marks.push_back(row);
        if (row.t != "progress" || overlay.owner == roadmap.tree.owner) continue;
        const Json::Value& mark = row.lattice.f.at("mark").value;
        read.otherMarks[overlay.owner.str()].push_back(read::Mark{row.id.column(), mark["status"].asString(), mark["outOfOrder"].asBool(),
                                                                  static_cast<std::int64_t>(row.ru), std::nullopt, Hlc{}});
      }
    }
    read.records = recordsOf(rows, account);
    if (rows.meta && rows.meta->lattice.f.contains("forkedFrom")) read.forkedFrom = rows.meta->lattice.f.at("forkedFrom").value.asString();
    engine.push_back(std::move(read));
  }

  const std::map<std::string, Document> before = documentsBefore(survey);
  const std::map<std::string, Document> after = documentsAfter(engine);
  REQUIRE_EQ(before.size(), 3u);
  REQUIRE_EQ(after.size(), 3u);
  for (const auto& [id, document] : before) {
    CHECK(differences(document, after.at(id)).empty());
    CHECK(document.toJson() == after.at(id).toJson());
  }
  const Document& read = after.at("t_0000000000000001");
  REQUIRE_EQ(read.steps.size(), 3u);
  CHECK_EQ(read.steps[0].id, std::string("bow"));
  CHECK_EQ(read.steps[0].color, std::string("terracotta"));
  CHECK_EQ(read.steps[0].status, std::string("none"));
  CHECK_EQ(read.steps[0].opens, std::string("t_0000000000000003"));
  CHECK_EQ(read.steps[1].branch, std::string("t_0000000000000002"));
  CHECK_FALSE(read.steps[2].present);
  REQUIRE_EQ(read.links.size(), 2u);
  CHECK_EQ(read.kinds[0].id, std::string("learn"));
  CHECK_FALSE(read.kinds[0].present);
  REQUIRE_EQ(read.marks.size(), 2u);
  CHECK_EQ(read.marks[1].account, std::string("reader"));
  CHECK(read.marks[1].outOfOrder);
  CHECK(after.at("t_0000000000000002").stands);
  CHECK_EQ(after.at("t_0000000000000002").reach, std::string("public"));
}
