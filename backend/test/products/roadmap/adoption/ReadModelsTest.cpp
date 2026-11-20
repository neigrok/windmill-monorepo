#include "products/roadmap/adoption/ReadModels.h"

#include "platform/adapters/json/JsonText.h"
#include "test/testing.h"

#include <string>
#include <vector>

using namespace wm;
using namespace wm::roadmap::adoption;

namespace {

// One server's line for MCP get_tree of `t_cello`, read today, answering `value`.
Json::Value getTreeLine(const std::string& value) {
  Json::Value line(Json::objectValue);
  line["question"] = "mcp.getTree";
  line["subject"] = "t_cello";
  line["readableToday"] = true;
  line["answer"]["refused"] = false;
  line["answer"]["value"] = parse(value);
  line["seq"] = 7;
  return line;
}

StageReport compared(const std::string& old, const std::string& now) {
  return compareAnswers({getTreeLine(old)}, {getTreeLine(now)}, PrivateRecord(std::nullopt));
}

}

TEST(read_models_hold_get_tree_the_same_when_its_steps_edges_and_prerequisites_come_in_another_order) {
  const StageReport report = compared(
      R"({"count": 3, "edges": [{"from": "bow", "to": "scale"}, {"from": "bow", "to": "piece"}, {"from": "scale", "to": "piece"}],
          "tree": {"kinds": [{"id": "k_a", "hue": "sky"}, {"id": "k_b", "hue": "olive"}],
                   "nodes": [{"id": "bow", "prerequisites": []}, {"id": "piece", "prerequisites": ["bow", "scale"]},
                             {"id": "scale", "prerequisites": ["bow"]}]}})",
      R"({"count": 3, "edges": [{"from": "scale", "to": "piece"}, {"from": "bow", "to": "scale"}, {"from": "bow", "to": "piece"}],
          "tree": {"kinds": [{"id": "k_a", "hue": "sky"}, {"id": "k_b", "hue": "olive"}],
                   "nodes": [{"id": "scale", "prerequisites": ["bow"]}, {"id": "bow", "prerequisites": []},
                             {"id": "piece", "prerequisites": ["scale", "bow"]}]}})");
  CHECK_EQ(report.verdict, std::string("same"));
  CHECK(report.passed);
  CHECK_EQ(dump(report.counts.toJson()), std::string(R"({"same":{"mcp":{"getTree":1}}})"));
}

TEST(read_models_tell_get_tree_apart_when_an_edge_or_a_prerequisite_is_missing_extra_or_repeated) {
  const std::string old =
      R"({"count": 2, "edges": [{"from": "bow", "to": "scale"}],
          "tree": {"nodes": [{"id": "bow", "prerequisites": []}, {"id": "scale", "prerequisites": ["bow"]}]}})";
  for (const char* now : {
           R"({"count": 2, "edges": [],
               "tree": {"nodes": [{"id": "bow", "prerequisites": []}, {"id": "scale", "prerequisites": ["bow"]}]}})",
           R"({"count": 2, "edges": [{"from": "bow", "to": "scale"}, {"from": "scale", "to": "bow"}],
               "tree": {"nodes": [{"id": "bow", "prerequisites": []}, {"id": "scale", "prerequisites": ["bow"]}]}})",
           R"({"count": 2, "edges": [{"from": "bow", "to": "scale"}, {"from": "bow", "to": "scale"}],
               "tree": {"nodes": [{"id": "bow", "prerequisites": []}, {"id": "scale", "prerequisites": ["bow"]}]}})",
           R"({"count": 2, "edges": [{"from": "bow", "to": "scale"}],
               "tree": {"nodes": [{"id": "bow", "prerequisites": []}, {"id": "scale", "prerequisites": []}]}})",
           R"({"count": 2, "edges": [{"from": "bow", "to": "scale"}],
               "tree": {"nodes": [{"id": "bow", "prerequisites": ["scale"]}, {"id": "scale", "prerequisites": ["bow"]}]}})",
           R"({"count": 2, "edges": [{"from": "bow", "to": "scale"}],
               "tree": {"nodes": [{"id": "bow", "prerequisites": []}, {"id": "scale", "prerequisites": ["bow", "bow"]}]}})"}) {
    const StageReport report = compared(old, now);
    CHECK_EQ(report.verdict, std::string("differs"));
    CHECK_FALSE(report.passed);
    CHECK_EQ(dump(report.counts.toJson()), std::string(R"({"differ":{"mcp":{"getTree":1}}})"));
  }
}

TEST(read_models_keep_the_order_of_every_other_list_get_tree_answers) {
  const StageReport report = compared(
      R"({"count": 1, "tree": {"kinds": [{"id": "k_a", "hue": "sky"}, {"id": "k_b", "hue": "olive"}],
                               "nodes": [{"id": "bow", "prerequisites": []}]}})",
      R"({"count": 1, "tree": {"kinds": [{"id": "k_b", "hue": "olive"}, {"id": "k_a", "hue": "sky"}],
                               "nodes": [{"id": "bow", "prerequisites": []}]}})");
  CHECK_EQ(report.verdict, std::string("differs"));
  CHECK_FALSE(report.passed);
  CHECK_EQ(dump(report.counts.toJson()), std::string(R"({"differ":{"mcp":{"getTree":1}}})"));
}
