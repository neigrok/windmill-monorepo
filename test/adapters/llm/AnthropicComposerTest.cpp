#include "adapters/llm/AnthropicComposer.h"

#include "test/testing.h"

#include <optional>
#include <string>
#include <utility>

using namespace wm;

TEST(stripped_plan_leaves_a_clean_plan_untouched) {
  const std::string plan = "# Learn to sail\n\n## Basics\n- [x] Read the theory\n1. Rig the boat";
  CHECK_EQ(strippedPlan(plan), plan);
}

TEST(stripped_plan_trims_surrounding_whitespace) {
  CHECK_EQ(strippedPlan("\n\n# Plan\n- Step one\n\n  "), std::string("# Plan\n- Step one"));
}

TEST(stripped_plan_removes_a_wrapping_code_fence) {
  CHECK_EQ(strippedPlan("```\n# Plan\n- Step one\n```"), std::string("# Plan\n- Step one"));
  CHECK_EQ(strippedPlan("```markdown\n# Plan\n- Step one\n```\n"), std::string("# Plan\n- Step one"));
}

TEST(stripped_plan_removes_a_lone_leading_or_trailing_fence) {
  CHECK_EQ(strippedPlan("```markdown\n# Plan\n- Step one"), std::string("# Plan\n- Step one"));
  CHECK_EQ(strippedPlan("# Plan\n- Step one\n```"), std::string("# Plan\n- Step one"));
}

TEST(stripped_plan_keeps_backticks_that_are_not_fence_lines) {
  CHECK_EQ(strippedPlan("# Plan\n- Run `make ```weird``` target`"),
           std::string("# Plan\n- Run `make ```weird``` target`"));
}

TEST(stripped_plan_of_a_fence_only_reply_is_empty) {
  CHECK_EQ(strippedPlan("```"), std::string(""));
  CHECK_EQ(strippedPlan("```markdown\n```"), std::string(""));
  CHECK_EQ(strippedPlan("   \n\t"), std::string(""));
}

TEST(anthropic_composer_without_a_key_is_unconfigured_and_never_calls_upstream) {
  AnthropicComposer composer{""};
  CHECK_FALSE(composer.configured());
  std::optional<std::string> result = std::string("untouched");
  composer.compose("anything", [&](std::optional<std::string> plan) { result = std::move(plan); });
  CHECK(result == std::nullopt);
}

TEST(anthropic_composer_with_a_key_reports_configured) {
  AnthropicComposer composer{"sk-ant-test"};
  CHECK(composer.configured());
}
