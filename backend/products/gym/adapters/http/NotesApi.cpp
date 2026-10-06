#include "products/gym/adapters/http/NotesApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "products/gym/adapters/json/TrainingJson.h"

#include <optional>
#include <utility>

namespace wm::gym {

NotesApi::NotesApi(std::shared_ptr<NotesService> notes, std::shared_ptr<AuthService> auth)
    : notes_(std::move(notes)), auth_(std::move(auth)) {}

void NotesApi::listNotes(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  Json::Value body(Json::objectValue);
  body["notes"] = toJson(notes_->notes(*caller));
  cb(jsonResponse(body));
}

}
