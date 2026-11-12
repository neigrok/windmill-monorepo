#include "products/roadmap/adapters/json/CommandJson.h"

#include "platform/adapters/json/JsonText.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "test/testing.h"

#include <variant>

using namespace wm;

TEST(a_kind_description_payload_carries_only_the_registers_it_sets) {
  Command flagOnly = *commandFromJson("DescribeKind", parse("{\"id\": \"build\", \"crossBranchExempt\": true}"));
  const DescribeKind& flag = std::get<DescribeKind>(flagOnly);
  CHECK_EQ(flag.id, KindId{"build"});
  CHECK_FALSE(flag.description.has_value());
  CHECK_EQ(flag.crossBranchExempt, std::optional<bool>(true));
  CHECK_EQ(dump(commandPayload(flagOnly)), std::string("{\"crossBranchExempt\":true,\"id\":\"build\"}"));

  Command textOnly = *commandFromJson("DescribeKind", parse("{\"id\": \"build\", \"description\": \"Made things\"}"));
  const DescribeKind& text = std::get<DescribeKind>(textOnly);
  CHECK_EQ(text.description, std::optional<std::string>("Made things"));
  CHECK_FALSE(text.crossBranchExempt.has_value());
  CHECK_EQ(dump(commandPayload(textOnly)), std::string("{\"description\":\"Made things\",\"id\":\"build\"}"));

  Command both = *commandFromJson(
      "DescribeKind", parse("{\"id\": \"build\", \"description\": \"\", \"crossBranchExempt\": false}"));
  CHECK_EQ(dump(commandPayload(both)),
           std::string("{\"crossBranchExempt\":false,\"description\":\"\",\"id\":\"build\"}"));
}

TEST(add_kind_payload_carries_the_exemption_only_when_set) {
  Command exempt = *commandFromJson("AddKind", parse("{\"id\": \"drill\", \"hue\": \"gold\", \"crossBranchExempt\": true}"));
  CHECK(std::get<AddKind>(exempt).crossBranchExempt);
  CHECK_EQ(dump(commandPayload(exempt)), std::string("{\"crossBranchExempt\":true,\"hue\":\"gold\",\"id\":\"drill\"}"));

  Command plain = *commandFromJson("AddKind", parse("{\"id\": \"build\", \"hue\": \"sky\", \"label\": \"Build\"}"));
  CHECK_FALSE(std::get<AddKind>(plain).crossBranchExempt);
  CHECK_EQ(dump(commandPayload(plain)), std::string("{\"hue\":\"sky\",\"id\":\"build\",\"label\":\"Build\"}"));
}

TEST(batch_round_trips_every_member_and_refuses_a_member_it_cannot_decode) {
  const Command batch = Batch{{DeleteNode{NodeId{"a"}}, DeleteNode{NodeId{"b"}}, RemoveEdge{NodeId{"a"}, NodeId{"b"}}}};
  CHECK_EQ(commandKind(batch), std::string("Batch"));
  const std::string wire =
      "{\"commands\":[{\"kind\":\"DeleteNode\",\"payload\":{\"id\":\"a\"}},"
      "{\"kind\":\"DeleteNode\",\"payload\":{\"id\":\"b\"}},"
      "{\"kind\":\"RemoveEdge\",\"payload\":{\"from\":\"a\",\"to\":\"b\"}}]}";
  CHECK_EQ(dump(commandPayload(batch)), wire);

  std::optional<Command> decoded = commandFromJson("Batch", parse(wire));
  REQUIRE(decoded.has_value());
  const std::vector<Command>& members = std::get<Batch>(*decoded).commands;
  REQUIRE_EQ(members.size(), 3u);
  CHECK_EQ(std::get<DeleteNode>(members[0]).id, NodeId{"a"});
  CHECK_EQ(std::get<DeleteNode>(members[1]).id, NodeId{"b"});
  CHECK_EQ(std::get<RemoveEdge>(members[2]).from, NodeId{"a"});
  CHECK_EQ(std::get<RemoveEdge>(members[2]).to, NodeId{"b"});
  CHECK_EQ(dump(commandPayload(*decoded)), wire);

  CHECK_FALSE(commandFromJson("Batch", parse("{\"commands\":[{\"kind\":\"DeleteNode\",\"payload\":{\"id\":\"a\"}},"
                                             "{\"kind\":\"NoSuchCommand\",\"payload\":{}}]}"))
                  .has_value());
}

TEST(create_and_annotate_payloads_carry_the_tree_a_node_opens_and_a_replay_lands_what_the_write_did) {
  CreateNode created{NodeId{"a"}, "A", "star"};
  created.opens = TreeId{"t_sub"};
  const std::string createWire = "{\"color\":\"terracotta\",\"icon\":\"star\",\"id\":\"a\",\"label\":\"A\",\"opens\":\"t_sub\"}";
  CHECK_EQ(dump(commandPayload(Command{created})), createWire);
  const std::optional<Command> replayedCreate = commandFromJson("CreateNode", parse(createWire));
  REQUIRE(replayedCreate.has_value());
  CHECK_EQ(std::get<CreateNode>(*replayedCreate).opens, TreeId{"t_sub"});
  CHECK_EQ(dump(commandPayload(*replayedCreate)), createWire);

  CreateNode openingNone{NodeId{"a"}, "A", "star"};
  openingNone.opens = TreeId{};
  const std::string noneWire = "{\"color\":\"terracotta\",\"icon\":\"star\",\"id\":\"a\",\"label\":\"A\",\"opens\":\"\"}";
  CHECK_EQ(dump(commandPayload(Command{openingNone})), noneWire);
  const std::optional<Command> replayedNone = commandFromJson("CreateNode", parse(noneWire));
  REQUIRE(replayedNone.has_value());
  CHECK_EQ(std::get<CreateNode>(*replayedNone).opens, std::optional<TreeId>(TreeId{}));

  AnnotateNode pointed{NodeId{"b"}};
  pointed.opens = TreeId{"t_other"};
  const std::string pointWire = "{\"id\":\"b\",\"opens\":\"t_other\"}";
  CHECK_EQ(dump(commandPayload(Command{pointed})), pointWire);
  AnnotateNode cleared{NodeId{"a"}};
  cleared.opens = TreeId{};
  const std::string clearWire = "{\"id\":\"a\",\"opens\":\"\"}";
  CHECK_EQ(dump(commandPayload(Command{cleared})), clearWire);
  const std::optional<Command> replayedClear = commandFromJson("AnnotateNode", parse(clearWire));
  REQUIRE(replayedClear.has_value());
  CHECK_EQ(std::get<AnnotateNode>(*replayedClear).opens, std::optional<TreeId>(TreeId{}));

  const Command batch = Batch{{Command{created}, Command{CreateNode{NodeId{"b"}, "B", ""}}, Command{pointed}}};
  const std::optional<Command> replayedBatch = commandFromJson("Batch", commandPayload(batch));
  REQUIRE(replayedBatch.has_value());
  Legend legend;
  LooseGraph written;
  merge(written, legend, batch, Hlc{7, 0, "srv"});
  merge(written, legend, Command{cleared}, Hlc{8, 0, "srv"});
  LooseGraph replayed;
  merge(replayed, legend, *replayedBatch, Hlc{7, 0, "srv"});
  merge(replayed, legend, *replayedClear, Hlc{8, 0, "srv"});
  CHECK(replayed.exportState() == written.exportState());
  CHECK_EQ(written.nodeView(NodeId{"a"})->opens, TreeId{});
  CHECK_EQ(written.exportNode(NodeId{"a"})->opensAt, (Hlc{8, 0, "srv"}));
  CHECK_EQ(written.nodeView(NodeId{"b"})->opens, TreeId{"t_other"});
}

TEST(a_stored_create_or_annotate_row_without_opens_still_decodes_and_touches_no_pointer) {
  const std::string createWire = "{\"color\":\"sky\",\"icon\":\"\",\"id\":\"a\",\"label\":\"A\"}";
  const std::optional<Command> created = commandFromJson("CreateNode", parse(createWire));
  REQUIRE(created.has_value());
  CHECK_FALSE(std::get<CreateNode>(*created).opens.has_value());
  CHECK_EQ(dump(commandPayload(*created)), createWire);

  const std::string annotateWire = "{\"description\":\"a note\",\"id\":\"a\"}";
  const std::optional<Command> annotated = commandFromJson("AnnotateNode", parse(annotateWire));
  REQUIRE(annotated.has_value());
  CHECK_FALSE(std::get<AnnotateNode>(*annotated).opens.has_value());
  CHECK_EQ(dump(commandPayload(*annotated)), annotateWire);

  Legend legend;
  LooseGraph graph;
  graph.createNode(NodeId{"a"}, "A", "", NodeColor::sky, std::nullopt, Hlc{1, 0, "srv"});
  graph.setOpens(NodeId{"a"}, TreeId{"t_sub"}, Hlc{2, 0, "srv"});
  merge(graph, legend, *annotated, Hlc{3, 0, "srv"});
  merge(graph, legend, *created, Hlc{4, 0, "srv"});
  CHECK_EQ(graph.nodeView(NodeId{"a"})->opens, TreeId{"t_sub"});
  CHECK_EQ(graph.exportNode(NodeId{"a"})->opensAt, (Hlc{2, 0, "srv"}));
}

// No tool sends a ReorderKinds any more, but the log holds the rows it wrote and a client's frame can still land one:
// one decodes, alone or inside a Batch, and replays the order it set, so neither the row nor the Batch around it is
// skipped. One with an empty order, as a frame that moved no kind leaves, replays as nothing.
TEST(a_stored_legend_reorder_row_still_decodes_and_replays_the_order_it_set) {
  const std::optional<Command> row = commandFromJson("ReorderKinds", parse("{\"order\":[\"learn\",\"build\"]}"));
  REQUIRE(row.has_value());
  CHECK_EQ(std::get<ReorderKinds>(*row).order, (std::vector<KindId>{KindId{"learn"}, KindId{"build"}}));
  CHECK_EQ(dump(commandPayload(*row)), std::string("{\"order\":[\"learn\",\"build\"]}"));

  const std::optional<Command> batch = commandFromJson(
      "Batch", parse("{\"commands\":[{\"kind\":\"ReorderKinds\",\"payload\":{\"order\":[\"learn\",\"build\"]}},"
                     "{\"kind\":\"RenameKind\",\"payload\":{\"id\":\"build\",\"label\":\"Make\"}}]}"));
  REQUIRE(batch.has_value());
  CHECK_EQ(std::get<Batch>(*batch).commands.size(), 2u);

  LooseGraph graph;
  Legend legend({{KindId{"build"}, NodeColor::terracotta, "Build", ""}, {KindId{"learn"}, NodeColor::olive, "Learn", ""}},
                Hlc{1, 0, "seed"});
  merge(graph, legend, *batch, Hlc{2, 0, "seed"});
  std::vector<std::string> order;
  for (const Kind& kind : legend.kinds()) order.push_back(kind.id.str() + " " + kind.label);
  CHECK_EQ(order, (std::vector<std::string>{"learn Learn", "build Make"}));

  const std::optional<Command> empty = commandFromJson("ReorderKinds", parse("{\"order\":[]}"));
  REQUIRE(empty.has_value());
  CHECK(std::get<ReorderKinds>(*empty).order.empty());
  merge(graph, legend, *empty, Hlc{3, 0, "seed"});
  order.clear();
  for (const Kind& kind : legend.kinds()) order.push_back(kind.id.str() + " " + kind.label);
  CHECK_EQ(order, (std::vector<std::string>{"learn Learn", "build Make"}));
}
