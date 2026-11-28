#include "products/roadmap/domain/read/Reads.h"

#include "platform/domain/sync/Jcs.h"
#include "test/testing.h"

#include <json/json.h>

#include <filesystem>
#include <fstream>
#include <iterator>
#include <set>
#include <string>

// packages/api-contract/roadmap/domain/ over the server's read domain: every file of a read the server shares (the
// README's "Later server claim"), case by case, its complete answer compared by JCS. Board and landing are a device's
// reads alone, and the actions are a device's gestures; the web and iOS claim those.
using namespace wm;
using namespace wm::roadmap::read;

namespace {

namespace fs = std::filesystem;

const fs::path kReads{WM_ROADMAP_DOMAIN_DIR};
const char* kClaimed[] = {"account", "diagnostics", "graph", "guides", "legend", "pointers", "progress", "search"};

Json::Value vectorsOf(const std::string& file) {
  std::ifstream stream(kReads / (file + ".json"), std::ios::binary);
  return sync::parseJson(std::string{std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()});
}

Hlc stampOf(const Json::Value& value) {
  if (!value.isString()) return Hlc{};
  const std::optional<Hlc> stamp = parseHlc(value.asString());
  if (!stamp) throw std::invalid_argument("a vector holds a malformed stamp");
  return *stamp;
}

Instant instantOf(const Json::Value& value) {
  return value.isNumeric() ? Instant(value.asInt64()) : std::nullopt;
}

std::string text(const Json::Value& record, const char* field, const char* fallback = "") {
  return record.isMember(field) && record[field].isString() ? record[field].asString() : fallback;
}

bool flag(const Json::Value& record, const char* field, bool fallback) {
  return record.isMember(field) && record[field].isBool() ? record[field].asBool() : fallback;
}

RoadmapTree treeOf(const Json::Value& input) {
  TreeRecords records;
  records.id = input["id"].asString();
  records.present = flag(input, "present", true);
  records.read = text(input, "read", "loaded") == "unread" ? Read::unread : Read::loaded;
  if (input["parent"].isObject()) records.parent = Parent{input["parent"]["tree"].asString(), input["parent"]["step"].asString()};
  const Json::Value& meta = input["meta"];
  if (!input.isMember("meta") || meta.isObject()) {
    records.meta = Meta{.title = text(meta, "title"), .guide = text(meta, "guide"), .guideInherited = flag(meta, "guideInherited", false),
                        .root = text(meta, "root", records.id.c_str()), .depth = meta.isMember("depth") ? meta["depth"].asInt64() : 0,
                        .visibility = text(meta, "visibility", "private"), .reach = text(meta, "reach", "private")};
  }
  for (const Json::Value& node : input["nodes"]) {
    Step step{.id = node["id"].asString(), .present = flag(node, "present", true), .born = stampOf(node["born"]),
              .rc = instantOf(node["rc"]), .ru = instantOf(node["ru"]), .label = text(node, "label"),
              .icon = text(node, "icon"), .color = text(node, "color", "terracotta"), .ord = text(node, "ord"),
              .status = text(node, "status", "none"), .description = text(node, "description")};
    for (const Json::Value& link : node["links"]) step.links.push_back(StepLink{text(link, "url"), text(link, "label")});
    if (node["branch"].isString()) step.branch = node["branch"].asString();
    step.branchStamp = stampOf(node["branchStamp"]);
    records.nodes.push_back(std::move(step));
  }
  for (const Json::Value& edge : input["edges"])
    records.edges.push_back(Edge{edge["from"].asString(), edge["to"].asString(), flag(edge, "present", true)});
  for (const Json::Value& kind : input["kinds"])
    records.kinds.push_back(Kind{kind["id"].asString(), flag(kind, "present", true), stampOf(kind["born"]), text(kind, "hue"),
                                 text(kind, "label"), text(kind, "description"), text(kind, "ord")});
  for (const Json::Value& mark : input["marks"])
    records.marks.push_back(Mark{mark["node"].asString(), text(mark, "status", "none"), flag(mark, "outOfOrder", false),
                                 instantOf(mark["recordedAt"]), instantOf(mark["deviceAt"]), stampOf(mark["stamp"])});
  for (const Json::Value& pointer : input["pointers"])
    records.pointers.push_back(Pointer{pointer["node"].asString(), flag(pointer, "present", true), text(pointer, "opens"),
                                       stampOf(pointer["setAt"])});
  return RoadmapTree(std::move(records));
}

RoadmapAccount accountOf(const Json::Value& input) {
  std::vector<RoadmapTree> trees;
  for (const Json::Value& tree : input["trees"]) trees.push_back(treeOf(tree));
  return RoadmapAccount(std::move(trees));
}

Json::Value strings(const std::vector<std::string>& ids) {
  Json::Value list(Json::arrayValue);
  for (const std::string& id : ids) list.append(id);
  return list;
}

Json::Value optionalText(const std::optional<std::string>& value) { return value ? Json::Value(*value) : Json::Value(); }

Json::Value instant(const Instant& at) { return at ? Json::Value(Json::Int64(*at)) : Json::Value(); }

Json::Value pair(const std::string& from, const std::string& to) {
  Json::Value edge(Json::arrayValue);
  edge.append(from);
  edge.append(to);
  return edge;
}

Json::Value countsJson(const std::optional<Counts>& counts) {
  if (!counts) return Json::Value();
  Json::Value out(Json::objectValue);
  out["done"] = Json::UInt64(counts->done);
  out["total"] = Json::UInt64(counts->total);
  return out;
}

Json::Value graphJson(const FollowGraph& graph, const Json::Value& subjects) {
  Json::Value out(Json::objectValue);
  out["presentIds"] = strings(graph.ids());
  out["states"] = Json::Value(Json::arrayValue);
  for (const std::string& id : graph.ids()) {
    Json::Value state(Json::objectValue);
    state["id"] = id;
    state["state"] = stateName(graph.state(id));
    out["states"].append(state);
  }
  out["steps"] = Json::Value(Json::arrayValue);
  for (const Json::Value& subject : subjects) {
    const StepDetail detail = graph.detail(subject.asString());
    Json::Value step(Json::objectValue);
    step["id"] = detail.id;
    step["followed"] = Json::Value(Json::arrayValue);
    for (const Followed& followed : detail.followed) {
      Json::Value entry(Json::objectValue);
      entry["id"] = followed.id;
      entry["incoming"] = Json::Value(Json::arrayValue);
      for (const auto& [from, to] : followed.incoming) entry["incoming"].append(pair(from, to));
      entry["throughAbsent"] = followed.throughAbsent;
      step["followed"].append(entry);
    }
    step["unmet"] = strings(detail.unmet);
    step["owed"] = strings(detail.owed);
    step["owedCount"] = Json::UInt64(detail.owed.size());
    step["unlocks"] = strings(detail.unlocks);
    out["steps"].append(step);
  }
  return out;
}

Json::Value locationJson(Json::Value tree, const Location& location) {
  tree["standing"] = standingName(location.standing);
  tree["title"] = optionalText(location.title);
  if (!location.place) {
    tree["place"] = Json::Value();
    return tree;
  }
  Json::Value place(Json::objectValue);
  place["root"] = location.place->root;
  if (location.place->parent) {
    place["parent"]["tree"] = location.place->parent->tree;
    place["parent"]["step"] = location.place->parent->step;
  } else {
    place["parent"] = Json::Value();
  }
  place["path"] = Json::Value(Json::arrayValue);
  for (const PlaceStep& step : location.place->path) {
    Json::Value entry(Json::objectValue);
    entry["tree"] = step.tree;
    entry["step"] = step.step;
    entry["title"] = optionalText(step.title);
    place["path"].append(entry);
  }
  place["depth"] = Json::Int64(location.place->depth);
  tree["place"] = place;
  return tree;
}

Json::Value accountJson(const RoadmapAccount& account) {
  Json::Value out(Json::objectValue);
  out["trees"] = Json::Value(Json::arrayValue);
  for (const auto& [id, tree] : account.trees()) {
    Json::Value entry(Json::objectValue);
    entry["id"] = id;
    entry = locationJson(entry, account.locationOf(id));
    entry["read"] = tree.read == Read::loaded ? "loaded" : "unread";
    entry["counts"] = countsJson(account.counts(id));
    entry["complete"] = account.isComplete(id);
    entry["openings"] = Json::Value(Json::arrayValue);
    for (const Opening& opening : account.openingsOf(id)) {
      Json::Value row(Json::objectValue);
      row["node"] = opening.node;
      row["kind"] = openingKindName(opening.kind);
      row["tree"] = opening.tree;
      row["status"] = openingStatusName(opening.status);
      const bool loaded = opening.status == OpeningStatus::loaded;
      row["complete"] = loaded && account.isComplete(opening.tree);
      row["counts"] = loaded ? countsJson(account.counts(opening.tree)) : Json::Value();
      row["loop"] = opening.status != OpeningStatus::dangling && opening.status != OpeningStatus::unknown &&
                    account.sharesALoop(id, opening.tree);
      entry["openings"].append(row);
    }
    out["trees"].append(entry);
  }
  out["loops"] = Json::Value(Json::arrayValue);
  for (const auto& loop : account.loops()) out["loops"].append(strings(loop));
  return out;
}

Json::Value progressJson(const std::optional<Progress>& progress) {
  if (!progress) return Json::Value();
  Json::Value out(Json::objectValue);
  out["completed"] = strings(progress->completed);
  out["dates"] = Json::Value(Json::arrayValue);
  for (const DatedStep& date : progress->dates) {
    Json::Value entry(Json::objectValue);
    entry["node"] = date.node;
    entry["at"] = instant(date.at);
    out["dates"].append(entry);
  }
  return out;
}

Json::Value guidesJson(const std::vector<Guide>& guides) {
  Json::Value out(Json::arrayValue);
  for (const Guide& guide : guides) {
    Json::Value entry(Json::objectValue);
    entry["tree"] = guide.tree;
    entry["title"] = guide.title;
    entry["text"] = guide.text;
    entry["own"] = guide.own;
    out.append(entry);
  }
  return out;
}

Json::Value countedJson(const Counted& counted) {
  Json::Value out(Json::objectValue);
  out["count"] = Json::UInt64(counted.count);
  out["named"] = strings(counted.named);
  return out;
}

template <typename Entry, typename Write>
Json::Value listedJson(const Listed<Entry>& listed, Write write) {
  Json::Value out(Json::objectValue);
  out["entries"] = Json::Value(Json::arrayValue);
  for (const Entry& entry : listed.entries) out["entries"].append(write(entry));
  out["omitted"] = Json::UInt64(listed.omitted);
  return out;
}

Json::Value diagnosticsJson(const Diagnostics& found) {
  const auto edge = [](const std::pair<std::string, std::string>& entry) { return pair(entry.first, entry.second); };
  Json::Value out(Json::objectValue);
  out["cycles"] = listedJson(found.cycles, countedJson);
  out["absentCycles"] = listedJson(found.absentCycles, countedJson);
  out["missingEdges"] = listedJson(found.missingEdges, edge);
  out["selfEdges"] = listedJson(found.selfEdges, edge);
  out["smells"] = Json::Value(Json::arrayValue);
  for (const Smell& smell : found.smells) {
    Json::Value entry(Json::objectValue);
    entry["kind"] = smell.kind;
    entry["nodes"] = countedJson(smell.nodes);
    out["smells"].append(entry);
  }
  out["legendEmpty"] = found.legendEmpty;
  out["unclaimedHues"] = Json::Value(Json::arrayValue);
  for (const UnclaimedHue& hue : found.unclaimedHues) {
    Json::Value entry(Json::objectValue);
    entry["hue"] = hue.hue;
    entry["nodes"] = countedJson(hue.nodes);
    out["unclaimedHues"].append(entry);
  }
  return out;
}

Json::Value pointersJson(const PointerDiagnostics& found) {
  Json::Value out(Json::objectValue);
  out["treeLoops"] = Json::Value(Json::arrayValue);
  for (const TreeLoop& loop : found.treeLoops) {
    Json::Value entry(Json::objectValue);
    entry["node"] = loop.node;
    entry["path"] = Json::Value(Json::arrayValue);
    for (const PathStep& step : loop.path) {
      Json::Value at(Json::objectValue);
      at["tree"] = step.tree;
      at["title"] = optionalText(step.title);
      entry["path"].append(at);
    }
    entry["pathOmitted"] = Json::UInt64(loop.pathOmitted);
    out["treeLoops"].append(entry);
  }
  out["treeLoopsOmitted"] = Json::UInt64(found.treeLoopsOmitted);
  const auto named = [](const std::string& node, const std::string& tree) {
    Json::Value entry(Json::objectValue);
    entry["node"] = node;
    entry["tree"] = tree;
    return entry;
  };
  out["danglingPointers"] = Json::Value(Json::arrayValue);
  for (const DanglingPointer& pointer : found.danglingPointers) out["danglingPointers"].append(named(pointer.node, pointer.tree));
  out["danglingPointersOmitted"] = Json::UInt64(found.danglingPointersOmitted);
  out["staleBranches"] = Json::Value(Json::arrayValue);
  for (const StaleBranch& branch : found.staleBranches) out["staleBranches"].append(named(branch.node, branch.tree));
  out["staleBranchesOmitted"] = Json::UInt64(found.staleBranchesOmitted);
  return out;
}

Json::Value legendJson(const LegendRead& legend) {
  Json::Value out(Json::objectValue);
  out["ids"] = Json::Value(Json::arrayValue);
  for (const Kind& kind : legend.kinds()) out["ids"].append(kind.id);
  out["owners"] = Json::Value(Json::arrayValue);
  for (const HueOwner& owner : legend.owners()) {
    Json::Value entry(Json::objectValue);
    entry["hue"] = owner.hue;
    entry["id"] = owner.id;
    out["owners"].append(entry);
  }
  out["collisions"] = Json::Value(Json::arrayValue);
  for (const HueCollision& collision : legend.collisions()) {
    Json::Value entry(Json::objectValue);
    entry["hue"] = collision.hue;
    entry["owner"] = collision.owner;
    entry["others"] = strings(collision.others);
    out["collisions"].append(entry);
  }
  const auto hues = [](const std::vector<ShownHue>& entries, bool counted) {
    Json::Value list(Json::arrayValue);
    for (const ShownHue& shown : entries) {
      Json::Value entry(Json::objectValue);
      entry["hue"] = shown.hue;
      entry["id"] = shown.kind ? Json::Value(*shown.kind) : Json::Value(Json::nullValue);
      if (counted) entry["steps"] = Json::UInt64(shown.steps);
      list.append(entry);
    }
    return list;
  };
  out["shown"] = hues(legend.shown(), true);
  out["choices"] = hues(legend.choices(), false);
  const std::optional<std::string> free = legend.freeHue();
  out["free"] = free ? Json::Value(*free) : Json::Value(Json::nullValue);
  out["filters"] = hues(legend.filters(), false);
  out["removable"] = strings(legend.removable());
  return out;
}

Json::Value answer(const Json::Value& input) {
  const std::string operation = input["operation"].asString();
  if (operation == "account") return accountJson(accountOf(input));
  if (operation == "progress") return progressJson(accountOf(input).progress(input["tree"].asString()));
  if (operation == "guides") return guidesJson(accountOf(input).guides(input["tree"].asString()));
  if (operation == "pointers") return pointersJson(pointerDiagnostics(accountOf(input), input["tree"].asString()));
  const RoadmapTree tree = treeOf(input["tree"]);
  if (operation == "legend") return legendJson(LegendRead(tree));
  if (operation == "search") {
    const Json::Value& query = input["query"];
    NodeFilter filter;
    if (query["query"].isString()) filter.query = query["query"].asString();
    if (query["color"].isString()) filter.color = query["color"].asString();
    if (query["kind"].isString()) filter.kind = query["kind"].asString();
    return strings(selectNodes(tree, filter));
  }
  const FollowGraph graph(tree);
  if (operation == "graph") return graphJson(graph, input["subjects"]);
  if (operation == "diagnostics") return diagnosticsJson(diagnose(graph));
  throw std::invalid_argument("no server read claims the operation " + operation);
}

void runRead(const std::string& file, Json::ArrayIndex index) {
  const Json::Value vector = vectorsOf(file)[index];
  CHECK_EQ(sync::jcs(answer(vector["input"])), sync::jcs(vector["expect"]));
}

// The files a device claims alone: its Board, landing, replica, Activity and effects reads, its gestures and their Undo
// scenes, a Coach turn's records, a proposal's Apply and Reject, and the pinned rule book and values.
const std::set<std::string> kDevices{"board.json",             "landing.json",           "replica.json",
                                     "activity.json",          "effects.json",           "roadmaps-actions.json",
                                     "steps-actions.json",     "kinds-actions.json",     "progress-actions.json",
                                     "workspace-actions.json", "landing-actions.json",   "undo.json",
                                     "conversation-actions.json",                        "apply-actions.json",
                                     "turn-records-actions.json",                        "rules.json",
                                     "values.json"};

}

TEST(every_roadmap_read_file_is_claimed_by_the_server_or_named_a_device_s) {
  std::set<std::string> named(kDevices);
  for (const char* file : kClaimed) named.insert(std::string(file) + ".json");
  for (const auto& entry : fs::directory_iterator(kReads)) {
    const std::string file = entry.path().filename().string();
    if (entry.path().extension() == ".json" && !named.contains(file))
      ::testing::fail(("no runner claims roadmap/domain/" + file).c_str(), __FILE__, __LINE__);
  }
}

namespace {

[[maybe_unused]] const bool registered = [] {
  for (const char* file : kClaimed) {
    if (!fs::is_regular_file(kReads / (std::string(file) + ".json"))) {
      ::testing::Register{std::string("roadmap_reads/") + file, [file] {
        ::testing::fail((std::string("no roadmap read vectors named ") + file).c_str(), __FILE__, __LINE__);
      }};
      continue;
    }
    const Json::Value vectors = vectorsOf(file);
    for (Json::ArrayIndex i = 0; i < vectors.size(); ++i)
      ::testing::Register{std::string("roadmap_reads/") + file + ": " + vectors[i]["name"].asString(),
                          [file = std::string(file), i] { runRead(file, i); }};
  }
  return true;
}();

}
