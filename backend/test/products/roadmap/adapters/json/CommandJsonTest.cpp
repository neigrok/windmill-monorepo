#include "products/roadmap/adapters/json/CommandJson.h"

#include "platform/adapters/json/JsonText.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "test/testing.h"

#include <variant>

using namespace wm;

TEST(a_kind_description_payload_carries_the_description_when_it_sets_one) {
  Command described = *commandFromJson("DescribeKind", parse("{\"id\": \"build\", \"description\": \"Made things\"}"));
  CHECK_EQ(std::get<DescribeKind>(described).description, std::optional<std::string>("Made things"));
  CHECK_EQ(dump(commandPayload(described)), std::string("{\"description\":\"Made things\",\"id\":\"build\"}"));

  Command cleared = *commandFromJson("DescribeKind", parse("{\"id\": \"build\", \"description\": \"\"}"));
  CHECK_EQ(dump(commandPayload(cleared)), std::string("{\"description\":\"\",\"id\":\"build\"}"));
}

TEST(add_kind_payload_carries_the_label_and_description_it_sets) {
  Command plain = *commandFromJson("AddKind", parse("{\"id\": \"build\", \"hue\": \"sky\", \"label\": \"Build\"}"));
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

TEST(create_and_annotate_payloads_carry_the_tree_a_node_opens_and_decode_to_what_the_write_did) {
  CreateNode created{NodeId{"a"}, "A", "star"};
  created.opens = TreeId{"t_sub"};
  const std::string createWire = "{\"color\":\"terracotta\",\"icon\":\"star\",\"id\":\"a\",\"label\":\"A\",\"opens\":\"t_sub\"}";
  CHECK_EQ(dump(commandPayload(Command{created})), createWire);
  const std::optional<Command> decodedCreate = commandFromJson("CreateNode", parse(createWire));
  REQUIRE(decodedCreate.has_value());
  CHECK_EQ(std::get<CreateNode>(*decodedCreate).opens, TreeId{"t_sub"});
  CHECK_EQ(dump(commandPayload(*decodedCreate)), createWire);

  CreateNode openingNone{NodeId{"a"}, "A", "star"};
  openingNone.opens = TreeId{};
  const std::string noneWire = "{\"color\":\"terracotta\",\"icon\":\"star\",\"id\":\"a\",\"label\":\"A\",\"opens\":\"\"}";
  CHECK_EQ(dump(commandPayload(Command{openingNone})), noneWire);
  const std::optional<Command> decodedNone = commandFromJson("CreateNode", parse(noneWire));
  REQUIRE(decodedNone.has_value());
  CHECK_EQ(std::get<CreateNode>(*decodedNone).opens, std::optional<TreeId>(TreeId{}));

  AnnotateNode pointed{NodeId{"b"}};
  pointed.opens = TreeId{"t_other"};
  const std::string pointWire = "{\"id\":\"b\",\"opens\":\"t_other\"}";
  CHECK_EQ(dump(commandPayload(Command{pointed})), pointWire);
  AnnotateNode cleared{NodeId{"a"}};
  cleared.opens = TreeId{};
  const std::string clearWire = "{\"id\":\"a\",\"opens\":\"\"}";
  CHECK_EQ(dump(commandPayload(Command{cleared})), clearWire);
  const std::optional<Command> decodedClear = commandFromJson("AnnotateNode", parse(clearWire));
  REQUIRE(decodedClear.has_value());
  CHECK_EQ(std::get<AnnotateNode>(*decodedClear).opens, std::optional<TreeId>(TreeId{}));

  const Command batch = Batch{{Command{created}, Command{CreateNode{NodeId{"b"}, "B", ""}}, Command{pointed}}};
  const std::optional<Command> decodedBatch = commandFromJson("Batch", commandPayload(batch));
  REQUIRE(decodedBatch.has_value());
  Legend legend;
  LooseGraph written;
  merge(written, legend, batch, Hlc{7, 0, "srv"});
  merge(written, legend, Command{cleared}, Hlc{8, 0, "srv"});
  LooseGraph decoded;
  merge(decoded, legend, *decodedBatch, Hlc{7, 0, "srv"});
  merge(decoded, legend, *decodedClear, Hlc{8, 0, "srv"});
  CHECK(decoded.exportState() == written.exportState());
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
  graph.createNode(NodeId{"a"}, "A", "", NodeColor::sky, Hlc{1, 0, "srv"});
  graph.setOpens(NodeId{"a"}, TreeId{"t_sub"}, Hlc{2, 0, "srv"});
  merge(graph, legend, *annotated, Hlc{3, 0, "srv"});
  merge(graph, legend, *created, Hlc{4, 0, "srv"});
  CHECK_EQ(graph.nodeView(NodeId{"a"})->opens, TreeId{"t_sub"});
  CHECK_EQ(graph.exportNode(NodeId{"a"})->opensAt, (Hlc{2, 0, "srv"}));
}

// No tool sends a ReorderKinds any more, but the log holds the rows it wrote and a client's frame can still land one:
// one decodes, alone or inside a Batch, to the order it set, so neither the row nor the Batch around it is skipped.
// One with an empty order, as a frame that moved no kind leaves, sets nothing.
TEST(a_stored_legend_reorder_row_still_decodes_to_the_order_it_set) {
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

// Nothing writes a TransitiveReduction or a PruneDangling, but the log holds rows of both. Each decodes as itself, alone
// and inside a Batch: a row the decoder could not read is skipped by the log, and a Batch holding one with it.
TEST(a_stored_tidy_or_prune_row_decodes_as_itself_alone_and_inside_a_batch) {
  const std::optional<Command> tidy = commandFromJson("TransitiveReduction", parse("{}"));
  REQUIRE(tidy.has_value());
  CHECK(std::holds_alternative<TransitiveReduction>(*tidy));
  const std::optional<Command> prune = commandFromJson("PruneDangling", parse("{}"));
  REQUIRE(prune.has_value());
  CHECK(std::holds_alternative<PruneDangling>(*prune));

  const std::optional<Command> batch = commandFromJson(
      "Batch", parse(R"({"commands":[{"kind":"TransitiveReduction","payload":{}},{"kind":"PruneDangling","payload":{}},
        {"kind":"RenameNode","payload":{"id":"a","label":"Alpha"}}]})"));
  REQUIRE(batch.has_value());
  CHECK_EQ(dump(commandPayload(*batch)),
           std::string(R"({"commands":[{"kind":"TransitiveReduction","payload":{}},)"
                       R"({"kind":"PruneDangling","payload":{}},)"
                       R"({"kind":"RenameNode","payload":{"id":"a","label":"Alpha"}}]})"));
}

// A kind has no cross-branch flag, but the log holds rows that set one. Each still decodes, alone and inside a Batch,
// with the flag dropped: an AddKind or DescribeKind decodes to the rest of what it set, and a DescribeKind that set
// only the flag sets nothing.
TEST(a_stored_kind_row_that_carried_the_cross_branch_flag_decodes_without_it) {
  const auto legendAfter = [](const std::vector<std::pair<const char*, const char*>>& rows) {
    LooseGraph graph;
    Legend legend;
    std::uint64_t stamp = 1;
    for (const auto& [kind, payload] : rows) {
      const std::optional<Command> row = commandFromJson(kind, parse(payload));
      CHECK(row.has_value());
      if (row) merge(graph, legend, *row, Hlc{++stamp, 0, "seed"});
    }
    return legend.exportState();
  };

  const std::optional<Command> added =
      commandFromJson("AddKind", parse(R"({"id":"drill","hue":"gold","label":"Drill","crossBranchExempt":true})"));
  REQUIRE(added.has_value());
  CHECK_EQ(dump(commandPayload(*added)), std::string(R"({"hue":"gold","id":"drill","label":"Drill"})"));
  const std::optional<Command> described =
      commandFromJson("DescribeKind", parse(R"({"id":"drill","description":"Reps","crossBranchExempt":false})"));
  REQUIRE(described.has_value());
  CHECK_EQ(dump(commandPayload(*described)), std::string(R"({"description":"Reps","id":"drill"})"));
  const std::optional<Command> flagOnly = commandFromJson("DescribeKind", parse(R"({"id":"drill","crossBranchExempt":true})"));
  REQUIRE(flagOnly.has_value());
  CHECK_EQ(dump(commandPayload(*flagOnly)), std::string(R"({"id":"drill"})"));

  CHECK(legendAfter({{"AddKind", R"({"id":"drill","hue":"gold","label":"Drill","crossBranchExempt":true})"},
                     {"DescribeKind", R"({"id":"drill","description":"Reps","crossBranchExempt":false})"},
                     {"DescribeKind", R"({"id":"drill","crossBranchExempt":true})"}}) ==
        legendAfter({{"AddKind", R"({"id":"drill","hue":"gold","label":"Drill"})"},
                     {"DescribeKind", R"({"id":"drill","description":"Reps"})"},
                     {"DescribeKind", R"({"id":"drill"})"}}));

  const std::optional<Command> batch = commandFromJson(
      "Batch", parse(R"({"commands":[{"kind":"DescribeKind","payload":{"id":"drill","crossBranchExempt":true}},
        {"kind":"RenameKind","payload":{"id":"drill","label":"Drills"}}]})"));
  REQUIRE(batch.has_value());
  CHECK_EQ(dump(commandPayload(*batch)),
           std::string(R"({"commands":[{"kind":"DescribeKind","payload":{"id":"drill"}},)"
                       R"({"kind":"RenameKind","payload":{"id":"drill","label":"Drills"}}]})"));
}

// A node has no position, but the log holds rows that set one. A RepositionNode still decodes, alone and inside a
// Batch, and sets nothing; a CreateNode that carried x and y decodes without them, to the rest of what it set.
TEST(a_stored_row_that_set_a_position_decodes_without_it) {
  const auto graphAfter = [](const std::vector<std::pair<const char*, const char*>>& rows) {
    LooseGraph graph;
    Legend legend;
    std::uint64_t stamp = 1;
    for (const auto& [kind, payload] : rows) {
      const std::optional<Command> row = commandFromJson(kind, parse(payload));
      CHECK(row.has_value());
      if (row) merge(graph, legend, *row, Hlc{++stamp, 0, "seed"});
    }
    return graph.exportState();
  };

  const std::optional<Command> created =
      commandFromJson("CreateNode", parse(R"({"id":"a","label":"A","color":"sky","x":3,"y":4})"));
  REQUIRE(created.has_value());
  const std::optional<Command> plain = commandFromJson("CreateNode", parse(R"({"id":"a","label":"A","color":"sky"})"));
  REQUIRE(plain.has_value());
  CHECK_EQ(dump(commandPayload(*created)), dump(commandPayload(*plain)));
  const std::optional<Command> moved = commandFromJson("RepositionNode", parse(R"({"id":"a","x":3,"y":4})"));
  REQUIRE(moved.has_value());
  CHECK(std::holds_alternative<RepositionNode>(*moved));
  const std::optional<Command> batch = commandFromJson(
      "Batch", parse(R"({"commands":[{"kind":"RepositionNode","payload":{"id":"a","x":7,"y":8}},
        {"kind":"RenameNode","payload":{"id":"a","label":"Alpha"}}]})"));
  REQUIRE(batch.has_value());
  CHECK_EQ(dump(commandPayload(*batch)),
           std::string(R"({"commands":[{"kind":"RepositionNode","payload":{}},)"
                       R"({"kind":"RenameNode","payload":{"id":"a","label":"Alpha"}}]})"));

  CHECK(graphAfter({{"CreateNode", R"({"id":"a","label":"A","color":"sky","x":3,"y":4})"},
                    {"RepositionNode", R"({"id":"a","x":5,"y":6})"},
                    {"Batch", R"({"commands":[{"kind":"RepositionNode","payload":{"id":"a","x":7,"y":8}},
                                              {"kind":"RenameNode","payload":{"id":"a","label":"Alpha"}}]})"}}) ==
        graphAfter({{"CreateNode", R"({"id":"a","label":"A","color":"sky"})"},
                    {"Batch", R"({"commands":[]})"},
                    {"RenameNode", R"({"id":"a","label":"Alpha"})"}}));
}
