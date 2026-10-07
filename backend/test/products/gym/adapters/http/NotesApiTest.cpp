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

drogon::HttpResponsePtr list(Harness& h, const std::string& cookie = "s-live") {
  return send(h.notes, &NotesApi::listNotes, getRequest("/v1/gym/notes", cookie));
}

}  // namespace

TEST(gym_notes_list_empty_then_every_note_in_position_order) {
  Harness h;
  const UserId me = h.signIn("s-live");

  CHECK_EQ(dump(bodyOf(list(h))), std::string(R"({"notes":[]})"));

  h.repo.db.noteRows.push_back(
      Note{NoteId{"note_00000002"}, me, "What I am training for", "", 1, 1'700'000'060'000});
  h.repo.db.noteRows.push_back(
      Note{NoteId{"note_00000001"}, me, "How I want to be talked to", "Blunt. No praise.", 0, 1'700'000'000'000});

  CHECK_EQ(dump(bodyOf(list(h))),
           std::string(R"({"notes":[)"
                       R"({"body":"Blunt. No praise.","id":"note_00000001","position":0,)"
                       R"("title":"How I want to be talked to","updatedAt":1700000000000},)"
                       R"({"body":"","id":"note_00000002","position":1,)"
                       R"("title":"What I am training for","updatedAt":1700000060000}]})"));
}

TEST(gym_notes_list_is_owner_scoped_and_401s_signed_out) {
  Harness h;
  h.signIn("s-live");
  h.repo.db.noteRows.push_back(Note{NoteId{"note_00000001"}, UserId{"stranger"}, "Theirs", "", 0, 1});

  CHECK_EQ(list(h, "")->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(dump(bodyOf(list(h, ""))),
           std::string(R"({"error":"sign in to open your training log"})"));
  CHECK_EQ(dump(bodyOf(list(h))), std::string(R"({"notes":[]})"));
}
