#include "products/roadmap/adapters/json/CommandJson.h"

#include "platform/adapters/json/JsonText.h"
#include "test/testing.h"

#include <variant>

using namespace wm;

TEST(describe_kind_payload_carries_only_the_registers_it_sets) {
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
