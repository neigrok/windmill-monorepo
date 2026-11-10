#include "products/roadmap/adapters/json/SubgraphJson.h"

#include "products/roadmap/adapters/json/TreeJson.h"

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

std::optional<Lww<std::string>> registerFromJson(const Json::Value& field) {
  if (!field.isObject()) return std::nullopt;
  return Lww<std::string>{field.get("v", "").asString(), roadmapStamp(field.get("at", "").asString())};
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
