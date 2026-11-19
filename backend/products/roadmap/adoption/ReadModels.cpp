#include "products/roadmap/adoption/ReadModels.h"

#include "platform/adapters/json/JsonText.h"
#include "products/roadmap/adapters/json/TreeJson.h"
#include "products/roadmap/domain/Access.h"

#include <algorithm>
#include <functional>
#include <set>
#include <typeinfo>

namespace wm::roadmap::adoption {

namespace {

constexpr std::size_t kActivityTail = 20;
constexpr int kPageLimit = 1000;

Json::Value list(std::initializer_list<const char*> items) {
  Json::Value out(Json::arrayValue);
  for (const char* item : items) out.append(item);
  return out;
}


// An answer without the members named, wherever they are.
Json::Value without(const Json::Value& value, const std::set<std::string>& names) {
  if (value.isObject()) {
    Json::Value out(Json::objectValue);
    for (const std::string& name : value.getMemberNames()) {
      if (!names.contains(name)) out[name] = without(value[name], names);
    }
    return out;
  }
  if (!value.isArray()) return value;
  Json::Value out(Json::arrayValue);
  for (const Json::Value& item : value) out.append(without(item, names));
  return out;
}

// What a tool answered: its value, or its words where it answered none, and whether it refused, every `seq` and step
// `order` left out and the top seq kept in `seq`.
Json::Value told(ToolHost& host, const std::string& tool, const Json::Value& arguments, const UserId& caller, std::optional<std::int64_t>& seq) {
  const ToolResult result = host.callTool(tool, arguments, ToolCaller{caller, ToolScope::everything()});
  if (result.payload.isObject() && result.payload["seq"].isIntegral()) seq = result.payload["seq"].asInt64();
  Json::Value answer(Json::objectValue);
  answer["refused"] = result.isError;
  answer["value"] = result.payload.isNull() ? result.content : without(result.payload, {"seq", "order"});
  return answer;
}

Json::Value optional(const std::optional<Json::Value>& value) { return value ? *value : Json::Value("not found"); }

// A progress answer without what the engine's adds, what each subtree came to, and without each mark's stamp, which the
// move gives where roadmap held none: each mark's time is compared.
Json::Value progressOf(const std::optional<Json::Value>& value) {
  return value ? without(*value, {"subtrees", "at"}) : Json::Value("not found");
}

Json::Value sharedJson(const std::optional<SharedRoadmap>& shared) {
  if (!shared) return Json::Value("the shell as served");
  Json::Value out(Json::objectValue);
  out["title"] = shared->title;
  out["steps"] = Json::UInt64(shared->steps);
  out["visibility"] = toString(shared->visibility);
  out["isFork"] = shared->lineage.isFork;
  out["sourceTitle"] = shared->lineage.sourceTitle;
  out["forkCount"] = shared->lineage.forkCount;
  return out;
}

Json::Value readinessJson(const std::vector<TreeReadiness>& trees) {
  Json::Value out(Json::arrayValue);
  for (const TreeReadiness& tree : trees) {
    Json::Value entry(Json::objectValue);
    entry["id"] = tree.id.str();
    entry["title"] = tree.title;
    entry["lastActivityAtMs"] = Json::UInt64(tree.lastActivityAtMs);
    entry["total"] = tree.total;
    entry["done"] = tree.done;
    entry["ready"] = Json::Value(Json::arrayValue);
    for (const ReadyStep& step : tree.ready) {
      Json::Value ready(Json::objectValue);
      ready["id"] = step.id.str();
      ready["label"] = step.label;
      ready["color"] = std::string(toString(step.color));
      entry["ready"].append(ready);
    }
    out.append(entry);
  }
  return out;
}

Json::Value wallJson(const std::vector<GalleryEntry>& wall) {
  Json::Value out(Json::arrayValue);
  for (const GalleryEntry& entry : wall) out.append(toJson(entry));
  return out;
}

// One side's answer to one question, or that it failed to answer, by the failure's type alone: the old server fails on a
// roadmap whose stamps it cannot read.
Json::Value answered(const std::function<Json::Value()>& ask) {
  try {
    return ask();
  } catch (const std::exception& error) {
    return Json::Value(std::string("failed: ") + typeid(error).name());
  }
}

bool failed(const Json::Value& answer) { return answer.isString() && answer.asString().rfind("failed: ", 0) == 0; }

// MCP's steps by id: the engine's tools list a roadmap's steps in its order, the rooms' by id.
Json::Value stepsById(Json::Value answer) {
  const Json::Value& value = answer["value"];
  if (!value.isObject() || !value["tree"].isObject() || !value["tree"]["nodes"].isArray()) return answer;
  Json::Value& nodes = answer["value"]["tree"]["nodes"];
  std::vector<Json::Value> sorted(nodes.begin(), nodes.end());
  std::sort(sorted.begin(), sorted.end(), [](const Json::Value& a, const Json::Value& b) { return a["id"].asString() < b["id"].asString(); });
  nodes = Json::Value(Json::arrayValue);
  for (Json::Value& node : sorted) nodes.append(std::move(node));
  return answer;
}

// The questions of one side, each answered in a line of its own: what is asked, of which roadmap or account, whether the
// old server reads that today, the answer, and an MCP answer's seq.
class Answers {
public:
  explicit Answers(ReadModelSide& side) : side_(side) {}

  void ask(const std::string& question, const std::string& subject, bool readableToday,
           const std::function<Json::Value(ReadModelSide&, std::optional<std::int64_t>&)>& asked) {
    std::optional<std::int64_t> seq;
    Json::Value line(Json::objectValue);
    line["question"] = question;
    line["subject"] = subject;
    line["readableToday"] = readableToday;
    line["answer"] = answered([&] { return asked(side_, seq); });
    if (seq) line["seq"] = Json::Int64(*seq);
    lines_.push_back(std::move(line));
  }

  std::vector<Json::Value> lines() const { return lines_; }

private:
  ReadModelSide& side_;
  std::vector<Json::Value> lines_;
};

std::string keyOf(const Json::Value& line) { return line["question"].asString() + " " + line["subject"].asString(); }

}

std::vector<Json::Value> answersOf(ReadModelSide& side, const Survey& survey) {
  Answers answers(side);
  std::map<UserId, bool> owners;
  for (const auto& [id, surveyed] : survey.roadmaps()) {
    if (surveyed.deleted) continue;
    const bool readable = surveyed.readableToday;
    const auto ask = [&](const std::string& question, const std::function<Json::Value(ReadModelSide&)>& asked) {
      answers.ask(question, id, readable, [&](ReadModelSide& on, std::optional<std::int64_t>&) { return asked(on); });
    };
    ask("progress.toAStranger", [&](ReadModelSide& on) { return progressOf(on.trees.progressAnswer(id, std::nullopt)); });
    ask("sharePage.toAStranger", [&](ReadModelSide& on) { return sharedJson(on.share.sharedOf(id, std::nullopt)); });
    if (surveyed.owner == kHouseAccount) {
      ask("activity.tailToAStranger", [&](ReadModelSide& on) { return optional(on.trees.activityAnswer(id, std::nullopt, 0, kActivityTail)); });
      continue;
    }
    const UserId& owner = surveyed.owner;
    const auto [held, fresh] = owners.emplace(owner, readable);
    if (!fresh) held->second = held->second && readable;
    Json::Value tree(Json::objectValue);
    tree["treeId"] = id;
    tree["fields"] = list({"id", "label", "icon", "color", "kind", "order", "prerequisites", "status", "seedStatus", "state", "summary",
                           "description", "links", "opens", "subtree", "url"});
    tree["includeEdges"] = true;
    tree["includeGuides"] = true;
    tree["kindFields"] = list({"id", "hue", "label", "description"});
    tree["limit"] = kPageLimit;
    answers.ask("mcp.getTree", id, readable,
                [&](ReadModelSide& on, std::optional<std::int64_t>& seq) { return stepsById(told(on.mcp, "get_tree", tree, owner, seq)); });
    Json::Value progress(Json::objectValue);
    progress["treeId"] = id;
    progress["fields"] = list({"completed", "cleared", "outOfOrder"});
    answers.ask("mcp.getProgress", id, readable,
                [&](ReadModelSide& on, std::optional<std::int64_t>& seq) { return told(on.mcp, "get_progress", progress, owner, seq); });
    ask("progress.toTheOwner", [&](ReadModelSide& on) { return progressOf(on.trees.progressAnswer(id, owner)); });
    ask("activity.tail", [&](ReadModelSide& on) { return optional(on.trees.activityAnswer(id, owner, 0, kActivityTail)); });
    ask("sharePage.toTheOwner", [&](ReadModelSide& on) { return sharedJson(on.share.sharedOf(id, owner)); });
  }
  for (const auto& [owner, readable] : owners) {
    answers.ask("mcp.listTrees", owner.str(), readable, [&](ReadModelSide& on, std::optional<std::int64_t>& seq) {
      return told(on.mcp, "list_trees", Json::Value(Json::objectValue), owner, seq);
    });
    answers.ask("reminders.readiness", owner.str(), readable,
                [&](ReadModelSide& on, std::optional<std::int64_t>&) { return readinessJson(on.readiness(owner)); });
  }
  const bool everyPublicRootReadable = std::all_of(survey.roadmaps().begin(), survey.roadmaps().end(), [](const auto& entry) {
    const Surveyed& roadmap = entry.second;
    return roadmap.deleted || roadmap.readableToday || roadmap.roadmap->parent || roadmap.visibility != "public";
  });
  answers.ask("gallery", "", everyPublicRootReadable,
              [](ReadModelSide& on, std::optional<std::int64_t>&) { return wallJson(on.gallery.wall(Viewer{})); });
  return answers.lines();
}

StageReport compareAnswers(const std::vector<Json::Value>& old, const std::vector<Json::Value>& now, const PrivateRecord& record) {
  StageReport report;
  std::map<std::string, const Json::Value*> before;
  for (const Json::Value& line : old) before.emplace(keyOf(line), &line);
  std::vector<Json::Value> differ;
  bool same = true;
  for (const Json::Value& line : now) {
    const std::string question = line["question"].asString();
    const auto asked = before.find(keyOf(line));
    if (asked == before.end()) {
      report.counts.add("unaskedBefore." + question);
      differ.push_back(line);
      same = false;
      continue;
    }
    const Json::Value& was = *asked->second;
    before.erase(asked);
    if (failed(line["answer"])) report.counts.add("newFailed." + question);
    if (was.isMember("seq") && line.isMember("seq") && line["seq"].asInt64() > was["seq"].asInt64())
      report.counts.add("mcp.seqContinuedAboveTheOld");
    const bool held = dump(was["answer"]) == dump(line["answer"]);
    const bool readable = was["readableToday"].asBool();
    report.counts.add((!readable ? "unreadableToday." : held ? "same." : "differ.") + question);
    if (held) continue;
    same = same && !readable;
    Json::Value entry(Json::objectValue);
    entry["question"] = question;
    entry["subject"] = line["subject"];
    entry["readableToday"] = readable;
    entry["old"] = was["answer"];
    entry["new"] = line["answer"];
    differ.push_back(entry);
  }
  for (const auto& [key, line] : before) report.counts.add("unaskedAfter." + (*line)["question"].asString());
  record.write("read-models.jsonl", differ);
  report.passed = same && before.empty();
  report.verdict = report.passed ? "same" : "differs";
  return report;
}

}
