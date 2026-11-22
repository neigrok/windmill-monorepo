#include "products/gym/coach/CoachWords.h"

#include "products/gym/adapters/llm/AnthropicAsk.h"
#include "products/gym/coach/TurnGate.h"
#include "test/testing.h"

#include <stdexcept>
#include <string>

using namespace wm::gym;
using namespace wm::gym::coach;

// Every gate code but invalid-input, whose sentence is the violation the check found, reads a sentence
// from refusals.json, and every context read a turn admits reads a lead from first-content.json.
TEST(coach_words_give_every_gate_code_and_every_context_read_its_words) {
  const CoachWords& words = CoachWords::shipped();
  for (const char* code : {gate::notOffered, gate::seatRequired, gate::oneProposal, gate::oneNote, gate::volume, gate::stopped})
    CHECK_FALSE(words.refusal(code).empty());
  bool unknown = false;
  try {
    words.refusal(gate::invalidInput);
  } catch (const std::out_of_range&) {
    unknown = true;
  }
  CHECK(unknown);
  CHECK_EQ(words.refusal(gate::oneProposal, "workout"),
           std::string("you already wrote a workout proposal this turn; fold both into one document."));
  for (const char* read : {"list_sessions", "list_notes", "list_exercises", "list_routines", "get_session"})
    CHECK_FALSE(words.contextLead(read).empty());
  CHECK_EQ(words.contextLead("list_routines"), std::string("Here is what list_routines returns right now, exactly as it answers:"));
  CHECK_EQ(words.speaker("lifter"), std::string("Lifter"));
  CHECK_EQ(words.speaker("coach"), std::string("Coach"));
}

// The words run on every device, so none of them names one.
TEST(coach_words_name_no_device) {
  const CoachWords& words = CoachWords::shipped();
  CHECK_EQ(words.prompt().find("phone"), std::string::npos);
  for (const char* read : {"list_sessions", "list_notes", "list_exercises", "list_routines", "get_session"})
    CHECK_EQ(words.contextLead(read).find("phone"), std::string::npos);
  for (const char* code : {gate::notOffered, gate::seatRequired, gate::oneProposal, gate::oneNote, gate::volume, gate::stopped})
    CHECK_EQ(words.refusal(code).find("phone"), std::string::npos);
}

// A turn reads prompt.md as it is; Ask's two rules differ from it in the create_routine line alone.
TEST(coach_words_prompt_is_the_turns_and_asks_swap_only_the_create_routine_line) {
  const std::string& turn = CoachWords::shipped().prompt();
  CHECK_EQ(coachSystemPrompt(CoachRoutineRule::runs), turn);
  const std::size_t line = turn.find("\n- create_routine adds a NEW day");
  REQUIRE(line != std::string::npos);
  const std::string after = turn.substr(turn.find('\n', line + 1));
  for (const CoachRoutineRule rule : {CoachRoutineRule::drafts, CoachRoutineRule::unavailable}) {
    const std::string& ask = coachSystemPrompt(rule);
    CHECK_EQ(ask.substr(0, line + 1), turn.substr(0, line + 1));
    CHECK_EQ(ask.substr(ask.size() - after.size()), after);
    CHECK_EQ(ask.find("create_routine adds a NEW day"), std::string::npos);
  }
  CHECK(coachSystemPrompt(CoachRoutineRule::drafts).find("- create_routine prepares a new routine draft") != std::string::npos);
  CHECK(coachSystemPrompt(CoachRoutineRule::unavailable).find("- New routines cannot be saved") != std::string::npos);
}

TEST(coach_words_refuse_a_file_that_is_not_their_shape) {
  const auto refused = [](const char* firstContent, const char* refusals) {
    try {
      CoachWords("prompt", firstContent, refusals);
    } catch (const std::invalid_argument&) {
      return true;
    }
    return false;
  };
  const char* first = R"({"contextLeads":{"list_notes":"Notes:"},"earlierConversation":{"marker":"Earlier:","lifter":"Lifter","coach":"Coach"},"pictureOnlyQuestion":"Help."})";
  CHECK_FALSE(refused(first, R"({"stopped":"Stopped."})"));
  CHECK(refused(first, "[]"));
  CHECK(refused(first, R"({"stopped":""})"));
  CHECK(refused(R"({"contextLeads":{},"earlierConversation":{},"pictureOnlyQuestion":"Help."})", R"({"stopped":"Stopped."})"));
  CHECK(refused(R"({"contextLeads":{"list_notes":"Notes:"}} trailing)", R"({"stopped":"Stopped."})"));
}
