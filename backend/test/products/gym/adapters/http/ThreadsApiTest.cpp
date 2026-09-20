#include <future>
#include <zlib.h>
#include "products/gym/adapters/http/CoachImage.h"
#include <drogon/utils/Utilities.h>
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

TEST(coach_picture_decode_rejects_truncation_wrong_format_and_large_dimensions) {
  const auto png = drogon::utils::base64Decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNoaGgAAAMEAYFL09IQAAAAAElFTkSuQmCC");
  const auto decoded = decodeCoachImage("img_decode01", "image/png", png);
  REQUIRE(decoded.has_value());
  CHECK_EQ(decoded->attachment, (CoachAttachment{"img_decode01", "image/png", 1, 1, png.size()}));
  CHECK_EQ(decoded->data, png);
  CHECK_FALSE(decodeCoachImage("img_decode01", "image/jpeg", png).has_value());
  CHECK_FALSE(decodeCoachImage("img_decode01", "image/gif", png).has_value());
  CHECK_FALSE(decodeCoachImage("img_decode01", "image/png", png.substr(0, png.size() - 1)).has_value());
  CHECK_FALSE(decodeCoachImage("img_decode01", "image/png", std::string(kMaxCoachImageBytes + 1, 'x')).has_value());
  auto wide = png;
  wide[18] = 0x10;
  wide[19] = 0x01;
  const auto headerCrc = crc32(0, reinterpret_cast<const Bytef*>(wide.data() + 12), 17);
  for (unsigned index = 0; index < 4; ++index) wide[29 + index] = static_cast<char>(headerCrc >> (24 - index * 8));
  CHECK_FALSE(decodeCoachImage("img_decode01", "image/png", wide).has_value());
  auto corrupt = png;
  corrupt.replace(41, 6, "broken");
  const auto dataLength = corrupt.size() - 57;
  const auto dataCrc = crc32(0, reinterpret_cast<const Bytef*>(corrupt.data() + 37), dataLength + 4);
  for (unsigned index = 0; index < 4; ++index) corrupt[41 + dataLength + index] = static_cast<char>(dataCrc >> (24 - index * 8));
  CHECK_FALSE(decodeCoachImage("img_decode01", "image/png", corrupt).has_value());
}

TEST(coach_jpeg_decode_checks_pixels_and_refuses_truncated_data) {
  const auto jpeg = drogon::utils::base64Decode("/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAACKADAAQAAAABAAAACAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgACAAIAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8AKKKKAP/Z");
  const auto decoded = decodeCoachImage("img_jpeg0001", "image/jpeg", jpeg);
  REQUIRE(decoded.has_value());
  CHECK_EQ(decoded->attachment, (CoachAttachment{"img_jpeg0001", "image/jpeg", 8, 8, jpeg.size()}));
  CHECK_EQ(decoded->data, jpeg);
  CHECK_FALSE(decodeCoachImage("img_jpeg0001", "image/jpeg", jpeg.substr(0, jpeg.size()-2)).has_value());
  auto corrupt = jpeg;
  corrupt.erase(8, jpeg.size()/2);
  CHECK_FALSE(decodeCoachImage("img_jpeg0001", "image/jpeg", corrupt).has_value());
}

TEST(coach_upload_http_preserves_binary_and_metadata_without_creating_a_conversation) {
  Harness h;
  const auto owner = h.signIn("s-live");
  const auto png = drogon::utils::base64Decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNoaGgAAAMEAYFL09IQAAAAAElFTkSuQmCC");
  const auto request = getRequest("/v1/gym/threads/thr_photo001/attachments/img_photo001", "s-live");
  request->setMethod(drogon::Put);
  request->addHeader("content-type", "image/png");
  request->setBody(png);
  std::promise<drogon::HttpResponsePtr> reply;
  auto future = reply.get_future();
  h.threads.putImage(request, [&](const drogon::HttpResponsePtr& response) { reply.set_value(response); }, "thr_photo001", "img_photo001");
  const auto response = future.get();
  REQUIRE_EQ(response->getStatusCode(), drogon::k200OK);
  Json::Value expected(Json::objectValue);
  expected["attachment"] = toJson(CoachAttachment{"img_photo001", "image/png", 1, 1, png.size()});
  CHECK_EQ(bodyOf(response), expected);
  CHECK(h.threadService->threads(owner).empty());
  const auto read = send(h.threads, &ThreadsApi::getImage, getRequest("/", "s-live"), "thr_photo001", "img_photo001");
  CHECK_EQ(read->getStatusCode(), drogon::k200OK);
  CHECK_EQ(std::string(read->getBody()), png);
  CHECK_EQ(read->getHeader("cache-control"), std::string("private, no-store"));
  CHECK_EQ(send(h.threads, &ThreadsApi::getImage, getRequest("/"), "thr_photo001", "img_photo001")->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(send(h.threads, &ThreadsApi::getImage, getRequest("/", "s-live"), "thr_photo002", "img_photo001")->getStatusCode(), drogon::k404NotFound);
}
