#include "test/products/gym/adapters/http/GymApiFixture.h"

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

using namespace wm;
using namespace wm::fake;
using namespace wm::gym;
using namespace wm::gym::fake;
using namespace wm::gym::apitest;

// ThreadsApi over the fake store: Ask's threads read and deleted.

namespace {
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
  CHECK_EQ(body["threads"][0]["id"].asString(), std::string("thr_00000002"));
  CHECK_EQ(body["threads"][0]["title"].asString(), std::string("Bench “stuck” at 82.5 💀?"));
  CHECK_EQ(body["threads"][0]["outcome"]["kind"].asString(), std::string("read-only"));
  CHECK_EQ(body["threads"][0]["outcome"]["changes"].asInt(), 0);
  CHECK_FALSE(body["threads"][0]["outcome"].isMember("routine"));
  CHECK_EQ(body["threads"][0]["proposals"].size(), 0u);
  // The list carries no turns.
  CHECK_FALSE(body["threads"][0].isMember("turns"));
  CHECK_EQ(body["threads"][1]["id"].asString(), std::string("thr_00000001"));
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
  CHECK_EQ(h.repo.db.threadRows.size(), 1u);
}

TEST(gym_missing_proposal_evidence_keeps_an_explicit_unknown_outcome_on_both_thread_reads) {
  Harness h;
  const UserId lifter = h.signIn("s-live");
  seedThread(h, lifter, "thr_00000001", "Remove this routine?");
  AnswerReceipt receipt;
  receipt.proposals = {"prop_00000001"};
  h.repo.db.threadRows[0].turns.back().receipt = receipt;

  const auto detail = send(h.threads, &ThreadsApi::getThread,
      getRequest("/v1/gym/threads/thr_00000001", "s-live"), "thr_00000001");
  const auto list = send(h.threads, &ThreadsApi::listThreads,
      getRequest("/v1/gym/threads", "s-live"));
  CHECK_EQ(detail->getStatusCode(), drogon::k200OK);
  CHECK_EQ(list->getStatusCode(), drogon::k200OK);
  Json::Value expected = parse(R"({"id":"thr_00000001","title":"Remove this routine?",
      "createdAt":1700000000000,"askedAt":1700000000000,
      "outcome":{"kind":"unknown","changes":0},"proposals":[]})");
  Json::Value expectedList(Json::objectValue);
  expectedList["threads"] = Json::Value(Json::arrayValue);
  expectedList["threads"].append(expected);
  CHECK_EQ(dump(bodyOf(list)), dump(expectedList));
  expected["turns"] = parse(R"([
      {"from":"lifter","text":"Remove this routine?","at":1700000000000},
      {"from":"ask","text":"Your top set has not moved.","at":1700000000000,
       "receipt":{"version":1,"read":{"sets":0,"sessions":0,"weeks":0},
        "steps":[],"proposals":["prop_00000001"],"observations":[]}}])");
  CHECK_EQ(dump(bodyOf(detail)), dump(expected));
}

TEST(gym_thread_reads_admit_only_supported_complete_typed_receipts) {
  Harness h;
  const UserId lifter = h.signIn("s-live");
  seedThread(h, lifter, "thr_00000001", "Unreadable evidence");
  seedThread(h, lifter, "thr_00000002", "Available evidence");
  AnswerReceipt valid;
  valid.proposals = {"prop_missing1"};
  h.repo.db.threadRows[1].turns.back().receipt = valid;
  std::vector<AnswerReceipt> invalid(4, valid);
  invalid[0].version = 2;
  invalid[1].read.sets = -1;
  invalid[2].observations.push_back(SessionObservation{});
  SessionObservation movement;
  movement.coverage = ReadCoverage::movement;
  movement.exerciseId = ExerciseId{"bench-press"};
  movement.workout = WorkoutObservation{};
  invalid[3].observations.push_back(movement);
  for (const AnswerReceipt& receipt : invalid) {
    h.repo.db.threadRows[0].turns.back().receipt = receipt;
    const auto detail = send(h.threads, &ThreadsApi::getThread,
        getRequest("/v1/gym/threads/thr_00000001", "s-live"), "thr_00000001");
    const auto list = send(h.threads, &ThreadsApi::listThreads,
        getRequest("/v1/gym/threads", "s-live"));
    CHECK_EQ(detail->getStatusCode(), drogon::k200OK);
    CHECK_EQ(list->getStatusCode(), drogon::k200OK);
    CHECK_FALSE(bodyOf(detail)["turns"][1].isMember("receipt"));
    CHECK_EQ(bodyOf(detail)["outcome"], parse(R"({"kind":"read-only","changes":0})"));
    REQUIRE_EQ(bodyOf(list)["threads"].size(), 2u);
    CHECK_EQ(bodyOf(list)["threads"][0]["outcome"], parse(R"({"kind":"unknown","changes":0})"));
    CHECK_EQ(bodyOf(list)["threads"][1]["outcome"], parse(R"({"kind":"read-only","changes":0})"));
    CHECK_EQ(h.repo.db.threadRows[0].turns.back().receipt, std::optional<AnswerReceipt>{receipt});
    CHECK_EQ(h.repo.db.threadRows[1].turns.back().receipt, std::optional<AnswerReceipt>{valid});
  }
}
