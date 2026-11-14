#include "products/roadmap/adapters/json/SubgraphJson.h"

#include "products/roadmap/adapters/json/TreeJson.h"

#include <stdexcept>

namespace wm {

namespace {
const char* intentName(SubgraphIntent intent) {
  switch (intent) {
    case SubgraphIntent::live:  return "live";
    case SubgraphIntent::flush: return "flush";
    case SubgraphIntent::delta: return "delta";
    case SubgraphIntent::graft: return "graft";
  }
  return "live";
}

SubgraphIntent parseIntent(const std::string& name) {
  if (name == "flush") return SubgraphIntent::flush;
  if (name == "delta") return SubgraphIntent::delta;
  if (name == "graft") return SubgraphIntent::graft;
  return SubgraphIntent::live;
}

// A tree register on the wire: `{v, at}`, or null when the frame carries no information about it.
Json::Value registerJson(const std::optional<Lww<std::string>>& value) {
  if (!value) return Json::nullValue;
  Json::Value field(Json::objectValue);
  field["v"] = value->value;
  field["at"] = toString(value->stamp);
  return field;
}

// Anything else a frame names as a register is malformed: a value that is not a string would be
// coerced or read as a clear, and an unstamped one could never win.
std::optional<Lww<std::string>> registerFromJson(const Json::Value& field) {
  if (field.isNull()) return std::nullopt;
  if (!field.isObject() || !field["v"].isString() || !field["at"].isString())
    throw std::invalid_argument("a register is {v, at}: a string value and its stamp");
  const Hlc stamp = roadmapStamp(field["at"].asString());
  if (!stamp.isSet()) throw std::invalid_argument("a register's stamp is set");
  return Lww<std::string>{field["v"].asString(), stamp};
}
}

Json::Value toJson(const Subgraph& subgraph) {
  Json::Value root(Json::objectValue);
  root["t"] = "subgraph";
  root["v"] = 1;
  root["treeId"] = subgraph.treeId.str();
  root["frameId"] = subgraph.frameId;
  root["actor"] = subgraph.actor;
  root["intent"] = intentName(subgraph.intent);

  Json::Value graph = toJson(subgraph.graph);  // { nodes, edges } — hoisted to the top level
  root["nodes"] = graph["nodes"];
  root["edges"] = graph["edges"];
  root["kinds"] = toJson(subgraph.legend);

  Json::Value gestures(Json::arrayValue);
  for (const Gesture& gesture : subgraph.gestures) {
    Json::Value g(Json::objectValue);
    g["id"] = gesture.id;
    g["kind"] = gesture.kind;
    g["label"] = gesture.label;
    gestures.append(g);
  }
  root["gestures"] = gestures;

  root["title"] = registerJson(subgraph.title);
  root["guide"] = registerJson(subgraph.guide);

  if (subgraph.coverage) {
    Json::Value coverage(Json::objectValue);
    for (const auto& [actor, mark] : subgraph.coverage->marks) coverage[actor] = toString(mark);
    root["coverage"] = coverage;
  } else {
    root["coverage"] = Json::nullValue;
  }

  return root;
}

Subgraph subgraphFromJson(const Json::Value& root) {
  Subgraph subgraph;
  subgraph.treeId = TreeId{root.get("treeId", "").asString()};
  subgraph.frameId = root.get("frameId", "").asString();
  subgraph.actor = root.get("actor", "").asString();
  subgraph.intent = parseIntent(root.get("intent", "live").asString());

  subgraph.graph = graphStateFromJson(root);  // reads the top-level nodes/edges arrays
  subgraph.legend = legendStateFromJson(root.get("kinds", Json::Value(Json::arrayValue)));

  if (root.isMember("gestures")) {
    for (const Json::Value& g : root["gestures"]) {
      subgraph.gestures.push_back(Gesture{g.get("id", "").asString(), g.get("kind", "").asString(),
                                          g.get("label", "").asString()});
    }
  }

  subgraph.title = registerFromJson(root["title"]);
  subgraph.guide = registerFromJson(root["guide"]);

  // The subtrees the frame knowingly takes with the owning steps it deletes; a frame that names them in any other shape
  // is not one this server reads.
  if (root.isMember("branches")) {
    if (!root["branches"].isArray()) throw std::invalid_argument("branches is a list of tree ids");
    for (const Json::Value& branch : root["branches"]) {
      if (!branch.isString()) throw std::invalid_argument("branches is a list of tree ids");
      subgraph.branches.insert(TreeId{branch.asString()});
    }
  }

  if (root.isMember("coverage") && root["coverage"].isObject()) subgraph.coverage = versionVectorFromJson(root["coverage"]);

  return subgraph;
}

VersionVector versionVectorFromJson(const Json::Value& object) {
  VersionVector vector;
  if (!object.isObject()) return vector;
  for (const std::string& actor : object.getMemberNames()) vector.marks[actor] = roadmapStamp(object[actor].asString());
  return vector;
}

}
