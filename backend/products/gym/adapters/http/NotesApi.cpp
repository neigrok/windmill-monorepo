#include "products/gym/adapters/http/NotesApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "products/gym/adapters/csv/TrainingCsv.h"
#include "products/gym/adapters/json/TrainingJson.h"

#include <optional>
#include <utility>

namespace wm::gym {

namespace {
Json::Value wrapped(const std::vector<Note>& notes) {
  Json::Value body(Json::objectValue);
  body["notes"] = toJson(notes);
  return body;
}
}

NotesApi::NotesApi(std::shared_ptr<NotesService> notes, std::shared_ptr<AuthService> auth)
    : notes_(std::move(notes)), auth_(std::move(auth)) {}

void NotesApi::listNotes(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  cb(jsonResponse(wrapped(notes_->notes(*caller))));
}

// Upsert by the client-minted id: a fresh id lands last, the same id with the same text replays,
// the same id with different text is an edit. Every bound refusal is the entity's own sentence.
void NotesApi::saveNote(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                        const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (!json) {
    cb(error(drogon::k400BadRequest, "could not read that note"));
    return;
  }
  std::optional<Note> incoming;
  try {
    incoming = parseNoteWrite(*json, NoteId{id}, *caller);
  } catch (const InvalidTraining& refused) {
    cb(error(drogon::k400BadRequest, refused.what()));
    return;
  }

  const NoteWriteOutcome outcome = notes_->saveNote(*incoming);
  if (outcome.error == NoteWriteError::full) {
    cb(error(drogon::k409Conflict, "10 of 10 notes. Delete one to add another.", "notes-full"));
    return;
  }
  if (outcome.error == NoteWriteError::idTaken) {
    cb(error(drogon::k409Conflict, "that note id is already in use", "note-id-taken"));
    return;
  }
  Json::Value body(Json::objectValue);
  body["note"] = toJson(*outcome.note);
  cb(jsonResponse(body));
}

// Absent and already gone are one answer, so a retry lands the same 204.
void NotesApi::deleteNote(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                          const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  notes_->deleteNote(*caller, NoteId{id});
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  cb(response);
}

void NotesApi::reorderNotes(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (!json) {
    cb(error(drogon::k400BadRequest, "could not read that order"));
    return;
  }
  std::vector<NoteId> order;
  try {
    order = parseNotesOrder(*json);
  } catch (const InvalidTraining& refused) {
    cb(error(drogon::k400BadRequest, refused.what()));
    return;
  }

  const NotesOrderOutcome outcome = notes_->reorderNotes(*caller, order);
  if (outcome.error == NotesOrderError::mismatch) {
    cb(error(drogon::k400BadRequest, "that order does not name every note",
             "notes-order-mismatch"));
    return;
  }
  cb(jsonResponse(wrapped(outcome.notes)));
}

void NotesApi::exportNotes(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k200OK);
  response->setContentTypeCode(drogon::CT_TEXT_CSV);
  response->addHeader("Content-Disposition", "attachment; filename=\"windmill-gym-notes.csv\"");
  response->setBody(toCsv(notes_->exportedNotes(*caller)));
  cb(response);
}

}
