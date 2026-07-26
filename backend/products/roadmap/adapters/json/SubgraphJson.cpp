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
  root["kinds"] = toJson(subgraph.legend);     // an array of kind entries

  Json::Value gestures(Json::arrayValue);
  for (const Gesture& gesture : subgraph.gestures) {
    Json::Value g(Json::objectValue);
    g["id"] = gesture.id;
    g["kind"] = gesture.kind;
    g["label"] = gesture.label;
    gestures.append(g);
  }
  root["gestures"] = gestures;

  if (subgraph.title) {
    Json::Value title(Json::objectValue);
    title["v"] = subgraph.title->value;
    title["at"] = toString(subgraph.title->stamp);
    root["title"] = title;
  } else {
    root["title"] = Json::nullValue;
  }

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

  if (root.isMember("title") && root["title"].isObject()) {
    subgraph.title = Lww<std::string>{root["title"].get("v", "").asString(),
                                      parseHlc(root["title"].get("at", "").asString())};
  }

  if (root.isMember("coverage") && root["coverage"].isObject()) subgraph.coverage = versionVectorFromJson(root["coverage"]);

  return subgraph;
}

VersionVector versionVectorFromJson(const Json::Value& object) {
  VersionVector vector;
  if (!object.isObject()) return vector;
  for (const std::string& actor : object.getMemberNames()) vector.marks[actor] = parseHlc(object[actor].asString());
  return vector;
}

}
