#pragma once

#include "platform/application/AuthService.h"
#include "products/gym/application/NotesService.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm::gym {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

//   list   out : { "notes": [ { "id", "position", "title", "body", "updatedAt" } ] }
//   save   in  : { "title", "body" }       out : { "note": { … } }
//   order  in  : { "order": [ "note_…" ] } out : { "notes": [ … ] }
//
// Every refusal a lifter must branch on carries a code: `notes-full` (ten already stand),
// `note-id-taken` (an id another account holds), `notes-order-mismatch` (an order that does not
// name every note once). The three bound refusals are 400s with the entity's own sentence.
class NotesApi {
public:
  NotesApi(std::shared_ptr<NotesService> notes, std::shared_ptr<AuthService> auth);

  void listNotes(const drogon::HttpRequestPtr& req, HttpCallback&& cb);     // GET    /v1/gym/notes
  void saveNote(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                const std::string& id);                                     // PUT    /v1/gym/notes/{id}
  void deleteNote(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                  const std::string& id);                                   // DELETE /v1/gym/notes/{id}
  void reorderNotes(const drogon::HttpRequestPtr& req, HttpCallback&& cb);  // PUT    /v1/gym/notes
  void exportNotes(const drogon::HttpRequestPtr& req, HttpCallback&& cb);   // GET    /v1/gym/export/notes

private:
  std::shared_ptr<NotesService> notes_;
  std::shared_ptr<AuthService> auth_;
};

}
