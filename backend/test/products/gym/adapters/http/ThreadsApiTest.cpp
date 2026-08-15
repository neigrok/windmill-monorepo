#include "test/products/gym/adapters/http/GymApiFixture.h"

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <utility>

using namespace wm;
using namespace wm::fake;
using namespace wm::gym;
using namespace wm::gym::fake;
using namespace wm::gym::apitest;

// ThreadsApi over the fake store: Ask's threads read, deleted and exported, on doors that stay
// mounted with or without a vendor key.

// ---- Ask's threads (§O), over HTTP -------------------------------------------------------------

namespace {
// A conversation seeded straight into the store, as Ask would have written it: the title is the
// lifter's first message and the turns are what was said.
void seedThread(Harness& h, const UserId& owner, const std::string& id, const std::string& title,
                std::uint64_t at = 1'700'000'000'000) {
  h.repo.db.threadRows.push_back(AskThread{ThreadId{id},
                                        owner,
                                        title,
                                        at,
                                        at,
                                        {ThreadTurn{true, title, at},
                                         ThreadTurn{false, "Your top set has not moved.", at}},
                                        {}});
}
}

// The list is titles and outcomes and nothing else — no unread count, no badge, nothing waiting.
TEST(gym_threads_lists_the_lifters_own_words_and_what_came_of_each) {
  Harness h;
  const UserId lifter = h.signIn("s-live");
  seedThread(h, lifter, "thr_00000001", "Is my squat volume too low?");
  seedThread(h, lifter, "thr_00000002", "Bench “stuck” at 82.5 💀?", 1'700'000'100'000);
  seedThread(h, UserId{"stranger"}, "thr_00000003", "not yours");

  drogon::HttpResponsePtr response =
      send(h.threads, &ThreadsApi::listThreads, getRequest("/v1/gym/threads", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  const Json::Value body = bodyOf(response);
  REQUIRE_EQ(body["threads"].size(), 2u);
  // Newest asked first, and the title is the lifter's own bytes.
  CHECK_EQ(body["threads"][0]["id"].asString(), std::string("thr_00000002"));
  CHECK_EQ(body["threads"][0]["title"].asString(), std::string("Bench “stuck” at 82.5 💀?"));
  CHECK_EQ(body["threads"][0]["outcome"]["kind"].asString(), std::string("read-only"));
  CHECK_EQ(body["threads"][0]["outcome"]["changes"].asInt(), 0);
  CHECK_FALSE(body["threads"][0]["outcome"].isMember("routine"));
  CHECK_EQ(body["threads"][0]["proposals"].size(), 0u);
  // The list carries no turns: a list prints titles.
  CHECK_FALSE(body["threads"][0].isMember("turns"));
  CHECK_EQ(body["threads"][1]["id"].asString(), std::string("thr_00000001"));
  // …and there is no unread count, no badge, and nothing waiting. The reply is the list.
  CHECK_EQ(body.getMemberNames().size(), 1u);
}

TEST(gym_thread_reads_the_whole_conversation_and_another_accounts_is_absent) {
  Harness h;
  const UserId lifter = h.signIn("s-live");
  seedThread(h, lifter, "thr_00000001", "why is my bench stuck?");
  seedThread(h, UserId{"stranger"}, "thr_00000002", "not yours");

  drogon::HttpResponsePtr mine =
      send(h.threads, &ThreadsApi::getThread, getRequest("/v1/gym/threads/thr_00000001", "s-live"),
           "thr_00000001");
  drogon::HttpResponsePtr theirs =
      send(h.threads, &ThreadsApi::getThread, getRequest("/v1/gym/threads/thr_00000002", "s-live"),
           "thr_00000002");
  drogon::HttpResponsePtr absent =
      send(h.threads, &ThreadsApi::getThread, getRequest("/v1/gym/threads/thr_00009999", "s-live"),
           "thr_00009999");

  CHECK_EQ(mine->getStatusCode(), drogon::k200OK);
  const Json::Value body = bodyOf(mine);
  REQUIRE_EQ(body["turns"].size(), 2u);
  CHECK_EQ(body["turns"][0]["from"].asString(), std::string("lifter"));
  CHECK_EQ(body["turns"][0]["text"].asString(), std::string("why is my bench stuck?"));
  CHECK_EQ(body["turns"][1]["from"].asString(), std::string("ask"));
  // Another account's and an absent one are the same answer, byte for byte.
  CHECK_EQ(theirs->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(absent->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(theirs)), dump(bodyOf(absent)));
}

TEST(gym_thread_delete_removes_the_conversation_and_answers_nothing_for_another_accounts) {
  Harness h;
  const UserId lifter = h.signIn("s-live");
  seedThread(h, lifter, "thr_00000001", "why is my bench stuck?");
  seedThread(h, UserId{"stranger"}, "thr_00000002", "not yours");

  drogon::HttpResponsePtr removed =
      send(h.threads, &ThreadsApi::deleteThread, deleteRequest("/v1/gym/threads/thr_00000001", "s-live"),
           "thr_00000001");
  drogon::HttpResponsePtr theirs =
      send(h.threads, &ThreadsApi::deleteThread, deleteRequest("/v1/gym/threads/thr_00000002", "s-live"),
           "thr_00000002");

  CHECK_EQ(removed->getStatusCode(), drogon::k204NoContent);
  CHECK_EQ(theirs->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(h.repo.db.threadRows.size(), 1u);
  CHECK_EQ(h.repo.db.threadRows[0].id, ThreadId{"thr_00000002"});
}

// The threads export: the same deliberately dull file the sets get — no parameters, nothing omitted,
// and every turn byte for byte. The outcome the domain derived rides on every row of its thread.
TEST(gym_thread_export_is_a_csv_attachment_carrying_every_turn_and_the_outcome) {
  Harness h;
  const UserId lifter = h.signIn("s-live");
  h.repo.db.routineRows.push_back(Routine{RoutineId{"rt_00000001"}, lifter, "Push A", 0,
                                       {RoutineEntry{1, ExerciseId{"bench-press"}, 5, 5, 82.5,
                                                     180}}});
  seedThread(h, lifter, "thr_00000001", R"(why is my bench, uh, "stuck"?)");
  h.repo.db.proposalRows.push_back(RoutineProposal{
      ProposalHead{ProposalId{"prop_00000001"}, RoutineId{"rt_00000001"}, lifter,
                   ProposalIntent::revise, ProposalState::applied,
                   ProposalSource{ProposalDoor::ask, "", "", ThreadId{"thr_00000001"}},
                   "Heavier triples.", 4, 1'700'000'000'000, 1'700'000'000'000},
      1, "Push A", "Push A",
      {RoutineChange{1, ChangeKind::retargeted, ExerciseId{"bench-press"},
                     EntryTargets{5, 5, 82.5, 180}, EntryTargets{5, 3, 87.5, 180}, 0}}});

  drogon::HttpResponsePtr response =
      send(h.threads, &ThreadsApi::exportThreads, getRequest("/v1/gym/export/threads", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(response->getHeader("Content-Disposition"),
           std::string(R"(attachment; filename="windmill-gym-threads.csv")"));
  CHECK_EQ(std::string(response->getBody()),
           std::string("thread_id,title,outcome,changes,routine,created_at,turn_number,from,text,"
                       "said_at\r\n"
                       R"(thr_00000001,"why is my bench, uh, ""stuck""?",applied,4,Push A,)"
                       "2023-11-14T22:13:20Z,1,lifter,"
                       R"("why is my bench, uh, ""stuck""?",2023-11-14T22:13:20Z)"
                       "\r\n"
                       R"(thr_00000001,"why is my bench, uh, ""stuck""?",applied,4,Push A,)"
                       "2023-11-14T22:13:20Z,2,ask,Your top set has not moved.,"
                       "2023-11-14T22:13:20Z\r\n"));
}

// An account that has never asked anything still gets a file, and the file still names its columns —
// the same rule the sets export keeps: an empty export is an answer.
TEST(gym_thread_export_of_an_account_that_never_asked_is_still_a_header_row) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response =
      send(h.threads, &ThreadsApi::exportThreads, getRequest("/v1/gym/export/threads", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(std::string(response->getBody()),
           std::string("thread_id,title,outcome,changes,routine,created_at,turn_number,from,text,"
                       "said_at\r\n"));
}

// Every one of the four doors is owner-scoped like the rest of the product: an unsigned caller
// learns nothing at all, and touches nothing.
TEST(gym_threads_refuse_an_unsigned_caller_on_every_door) {
  Harness h;
  seedThread(h, UserId{"someone"}, "thr_00000001", "why is my bench stuck?");

  CHECK_EQ(send(h.threads, &ThreadsApi::listThreads, getRequest("/v1/gym/threads"))->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(send(h.threads, &ThreadsApi::getThread, getRequest("/v1/gym/threads/thr_00000001"),
                "thr_00000001")
               ->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(send(h.threads, &ThreadsApi::deleteThread, deleteRequest("/v1/gym/threads/thr_00000001"),
                "thr_00000001")
               ->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(send(h.threads, &ThreadsApi::exportThreads, getRequest("/v1/gym/export/threads"))
               ->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(h.repo.db.threadRows.size(), 1u);
}
