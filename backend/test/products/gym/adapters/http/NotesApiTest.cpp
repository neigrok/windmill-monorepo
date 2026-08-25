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

// NotesApi over the fake store: the wire every client codes against, byte for byte.

namespace {

Json::Value noteBody(const std::string& title, const std::string& body) {
  Json::Value json(Json::objectValue);
  json["title"] = title;
  json["body"] = body;
  return json;
}

drogon::HttpResponsePtr save(Harness& h, const std::string& id, const Json::Value& body,
                             const std::string& cookie = "s-live") {
  return send(h.notes, &NotesApi::saveNote, putRequest("/v1/gym/notes/" + id, body, cookie), id);
}

drogon::HttpResponsePtr list(Harness& h, const std::string& cookie = "s-live") {
  return send(h.notes, &NotesApi::listNotes, getRequest("/v1/gym/notes", cookie));
}

std::pair<std::string, std::string> said(const Json::Value& body) {
  return {body["code"].asString(), body["error"].asString()};
}

}  // namespace

TEST(gym_notes_list_empty_and_a_new_note_is_appended_last) {
  Harness h;
  h.signIn("s-live");
  h.clock.now = 1'700'000'000'000;

  CHECK_EQ(dump(bodyOf(list(h))), std::string(R"({"notes":[]})"));

  const drogon::HttpResponsePtr first =
      save(h, "note_00000001", noteBody("How I want to be talked to", "Blunt. No praise."));
  h.clock.now += 60'000;
  const drogon::HttpResponsePtr second =
      save(h, "note_00000002", noteBody("What I am training for", ""));

  CHECK_EQ(first->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(first)),
           std::string(R"({"note":{"body":"Blunt. No praise.","id":"note_00000001","position":0,)"
                       R"("title":"How I want to be talked to","updatedAt":1700000000000}})"));
  CHECK_EQ(dump(bodyOf(second)),
           std::string(R"({"note":{"body":"","id":"note_00000002","position":1,)"
                       R"("title":"What I am training for","updatedAt":1700000060000}})"));
  CHECK_EQ(dump(bodyOf(list(h))),
           std::string(R"({"notes":[)"
                       R"({"body":"Blunt. No praise.","id":"note_00000001","position":0,)"
                       R"("title":"How I want to be talked to","updatedAt":1700000000000},)"
                       R"({"body":"","id":"note_00000002","position":1,)"
                       R"("title":"What I am training for","updatedAt":1700000060000}]})"));
}

// The same id with the same text replays the stored row; with different text it edits in place.
TEST(gym_notes_put_is_an_upsert_on_the_clients_id) {
  Harness h;
  h.signIn("s-live");
  h.clock.now = 1'700'000'000'000;
  save(h, "note_00000001", noteBody("Tone", "Blunt."));
  h.clock.now += 60'000;

  const drogon::HttpResponsePtr replayed = save(h, "note_00000001", noteBody("Tone", "Blunt."));
  const drogon::HttpResponsePtr edited = save(h, "note_00000001", noteBody("Tone", "Blunt. Numbers first."));

  CHECK_EQ(replayed->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(replayed)["note"]["updatedAt"].asUInt64(), 1'700'000'000'000u);
  CHECK_EQ(edited->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(edited)["note"]["position"].asInt(), 0);
  CHECK_EQ(bodyOf(edited)["note"]["body"].asString(), std::string("Blunt. Numbers first."));
  CHECK_EQ(bodyOf(edited)["note"]["updatedAt"].asUInt64(), 1'700'000'060'000u);
  CHECK_EQ(h.repo.db.noteRows.size(), std::size_t{1});
}

// Every 400 is the entity's own sentence, and nothing lands behind a refusal.
TEST(gym_notes_refuse_the_three_bounds_and_an_unreadable_body_by_sentence) {
  Harness h;
  h.signIn("s-live");
  const std::string sixtyOne(61, 'a');
  const std::string fiveHundredOne(501, 'b');
  Json::Value notAnObject(Json::arrayValue);
  Json::Value numberTitle(Json::objectValue);
  numberTitle["title"] = 5;
  numberTitle["body"] = "";
  Json::Value noBody(Json::objectValue);
  noBody["title"] = "Tone";

  const auto refused = [&](const std::string& id, const Json::Value& body) {
    const drogon::HttpResponsePtr response = save(h, id, body);
    CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
    return said(bodyOf(response));
  };
  CHECK_EQ(refused("note_00000001", noteBody("   ", "x")), std::pair(std::string(""), std::string("a note needs a title")));
  CHECK_EQ(refused("note_00000001", noteBody(sixtyOne, "")), std::pair(std::string(""), std::string("a title runs to 60 characters")));
  CHECK_EQ(refused("note_00000001", noteBody("Tone", fiveHundredOne)), std::pair(std::string(""), std::string("a note runs to 500 bytes")));
  CHECK_EQ(refused("note_1", noteBody("Tone", "")), std::pair(std::string(""), std::string("could not read that note")));
  CHECK_EQ(refused("note_00000001", notAnObject), std::pair(std::string(""), std::string("could not read that note")));
  CHECK_EQ(refused("note_00000001", numberTitle), std::pair(std::string(""), std::string("could not read that note")));
  CHECK_EQ(refused("note_00000001", noBody), std::pair(std::string(""), std::string("could not read that note")));
  // A NUL rides the wire as a json escape and would truncate a `text` column at its own head.
  CHECK_EQ(refused("note_00000001", noteBody("Tone", std::string("bench\0stuck", 11))),
           std::pair(std::string(""), std::string("could not read that note")));
  // A body that is not json at all.
  auto raw = drogon::HttpRequest::newHttpRequest();
  raw->setMethod(drogon::Put);
  raw->setPath("/v1/gym/notes/note_00000001");
  raw->setContentTypeCode(drogon::CT_TEXT_PLAIN);
  raw->setBody("not json");
  raw->addCookie("wm_session", "s-live");
  const drogon::HttpResponsePtr unreadable = send(h.notes, &NotesApi::saveNote, raw, std::string("note_00000001"));
  CHECK_EQ(unreadable->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(bodyOf(unreadable)["error"].asString(), std::string("could not read that note"));
  CHECK_EQ(h.repo.db.noteRows.size(), std::size_t{0});
}

TEST(gym_notes_stop_at_ten_and_say_so_in_the_add_rows_words) {
  Harness h;
  h.signIn("s-live");
  for (int at = 1; at <= 10; ++at)
    CHECK_EQ(save(h, "note_000000" + std::to_string(10 + at), noteBody("Note " + std::to_string(at), ""))
                 ->getStatusCode(),
             drogon::k200OK);

  const drogon::HttpResponsePtr eleventh = save(h, "note_00000099", noteBody("One too many", ""));

  CHECK_EQ(eleventh->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(dump(bodyOf(eleventh)),
           std::string(R"({"code":"notes-full","error":"10 of 10 notes. Delete one to add another."})"));
  CHECK_EQ(h.repo.db.noteRows.size(), std::size_t{10});
  // An edit at ten is not an eleventh.
  CHECK_EQ(save(h, "note_00000020", noteBody("Note 10", "still fits"))->getStatusCode(), drogon::k200OK);
}

TEST(gym_notes_refuse_an_id_another_account_holds_by_code) {
  Harness h;
  h.signIn("s-live");
  h.repo.db.noteRows.push_back(Note{NoteId{"note_00000001"}, UserId{"stranger"}, "Theirs", "", 0, 1});

  const drogon::HttpResponsePtr taken = save(h, "note_00000001", noteBody("Mine now", ""));

  CHECK_EQ(taken->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(dump(bodyOf(taken)),
           std::string(R"({"code":"note-id-taken","error":"that note id is already in use"})"));
  CHECK_EQ(h.repo.db.noteRows[0].title, std::string("Theirs"));
  CHECK_EQ(dump(bodyOf(list(h))), std::string(R"({"notes":[]})"));
}

TEST(gym_notes_delete_is_204_twice_and_closes_the_gap) {
  Harness h;
  h.signIn("s-live");
  save(h, "note_00000001", noteBody("A", ""));
  save(h, "note_00000002", noteBody("B", ""));
  save(h, "note_00000003", noteBody("C", ""));

  const drogon::HttpResponsePtr gone = send(h.notes, &NotesApi::deleteNote,
                                            deleteRequest("/v1/gym/notes/note_00000002", "s-live"),
                                            std::string("note_00000002"));
  const drogon::HttpResponsePtr again = send(h.notes, &NotesApi::deleteNote,
                                             deleteRequest("/v1/gym/notes/note_00000002", "s-live"),
                                             std::string("note_00000002"));

  CHECK_EQ(gone->getStatusCode(), drogon::k204NoContent);
  CHECK_EQ(again->getStatusCode(), drogon::k204NoContent);
  const Json::Value left = bodyOf(list(h))["notes"];
  REQUIRE_EQ(left.size(), 2u);
  CHECK_EQ(left[0]["id"].asString(), std::string("note_00000001"));
  CHECK_EQ(left[0]["position"].asInt(), 0);
  CHECK_EQ(left[1]["id"].asString(), std::string("note_00000003"));
  CHECK_EQ(left[1]["position"].asInt(), 1);
}

TEST(gym_notes_order_is_replaced_whole_or_refused_by_code) {
  Harness h;
  h.signIn("s-live");
  save(h, "note_00000001", noteBody("A", ""));
  save(h, "note_00000002", noteBody("B", ""));

  Json::Value order(Json::objectValue);
  order["order"] = Json::Value(Json::arrayValue);
  order["order"].append("note_00000002");
  order["order"].append("note_00000001");
  const drogon::HttpResponsePtr moved =
      send(h.notes, &NotesApi::reorderNotes, putRequest("/v1/gym/notes", order, "s-live"));

  CHECK_EQ(moved->getStatusCode(), drogon::k200OK);
  const Json::Value notes = bodyOf(moved)["notes"];
  REQUIRE_EQ(notes.size(), 2u);
  CHECK_EQ(notes[0]["id"].asString(), std::string("note_00000002"));
  CHECK_EQ(notes[0]["position"].asInt(), 0);
  CHECK_EQ(notes[1]["id"].asString(), std::string("note_00000001"));
  CHECK_EQ(dump(bodyOf(list(h))), dump(bodyOf(moved)));

  Json::Value partial(Json::objectValue);
  partial["order"] = Json::Value(Json::arrayValue);
  partial["order"].append("note_00000001");
  const drogon::HttpResponsePtr mismatch =
      send(h.notes, &NotesApi::reorderNotes, putRequest("/v1/gym/notes", partial, "s-live"));
  CHECK_EQ(mismatch->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(mismatch)),
           std::string(R"({"code":"notes-order-mismatch","error":"that order does not name every note"})"));

  Json::Value notAList(Json::objectValue);
  notAList["order"] = "note_00000001";
  const drogon::HttpResponsePtr unreadable =
      send(h.notes, &NotesApi::reorderNotes, putRequest("/v1/gym/notes", notAList, "s-live"));
  CHECK_EQ(unreadable->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(bodyOf(unreadable)["error"].asString(), std::string("could not read that order"));
  CHECK_EQ(bodyOf(list(h))["notes"][0]["id"].asString(), std::string("note_00000002"));   // nothing moved
}

TEST(gym_notes_are_owner_scoped_on_every_door) {
  Harness h;
  h.signIn("s-live");
  Json::Value order(Json::objectValue);
  order["order"] = Json::Value(Json::arrayValue);

  CHECK_EQ(list(h, "")->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(save(h, "note_00000001", noteBody("Tone", ""), "")->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(send(h.notes, &NotesApi::deleteNote, deleteRequest("/v1/gym/notes/note_00000001"),
                std::string("note_00000001"))
               ->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(send(h.notes, &NotesApi::reorderNotes, putRequest("/v1/gym/notes", order))->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(send(h.notes, &NotesApi::exportNotes, getRequest("/v1/gym/export/notes"))->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(dump(bodyOf(list(h, ""))),
           std::string(R"({"error":"sign in to open your training log"})"));
  CHECK_EQ(h.repo.db.noteRows.size(), std::size_t{0});
}

TEST(gym_notes_export_is_a_csv_attachment_in_precedence_order) {
  Harness h;
  h.signIn("s-live");
  h.clock.now = 1'700'000'000'000;
  save(h, "note_00000001", noteBody("How I want to be talked to", "Blunt, no praise.\nNumbers first."));
  save(h, "note_00000002", noteBody("What I am training for", ""));
  h.repo.db.noteRows.push_back(Note{NoteId{"note_00000009"}, UserId{"stranger"}, "Theirs", "", 0, 1});

  const drogon::HttpResponsePtr response =
      send(h.notes, &NotesApi::exportNotes, getRequest("/v1/gym/export/notes", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(response->getHeader("Content-Disposition"),
           std::string(R"(attachment; filename="windmill-gym-notes.csv")"));
  CHECK_EQ(std::string(response->getBody()),
           std::string("position,title,body,updated_at\r\n"
                       "0,How I want to be talked to,\"Blunt, no praise.\nNumbers first.\","
                       "2023-11-14T22:13:20Z\r\n"
                       "1,What I am training for,,2023-11-14T22:13:20Z\r\n"));
}
