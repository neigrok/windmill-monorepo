#pragma once

#include "platform/application/AuthService.h"
#include "platform/ports/Clock.h"
#include "products/gym/application/BodyweightService.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm::gym {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

//   list   ?from=YYYY-MM-DD&to=YYYY-MM-DD   out : { "entries": [ <entry> ], "latest": <entry> | null }
//   save   in  : { "weightKg", "recordedAt" } out : { "entry": <entry> }
//   entry      : { "dateLocal": "YYYY-MM-DD", "weightKg": n, "recordedAt": ms }
//
// The day in the path is the identity and the lifter's own calendar. Every refusal is a 400 with
// one of four sentences, decided in this order: `could not read that date` (the path's day, or a
// bound, is not a calendar day) · `A weigh-in is not a forecast — today or earlier.` (the day is
// more than one day past the server's UTC today — the one opinion a server clock has about a
// weigh-in, and wide enough that no lifter's local today is ever refused) · `could not read that
// weigh-in` (no json, not an object, a weight that is not a number, an instant that is not an
// integer) · `Between 20 and 400 kg — check the number.` (the weight, after rounding to two
// decimals) · then `could not read that weigh-in` once more for an instant outside the domain's
// band. No refusal carries a code — none has a branch a client repairs by re-minting.
class BodyweightApi {
public:
  BodyweightApi(std::shared_ptr<BodyweightService> bodyweight, std::shared_ptr<AuthService> auth,
                Clock& clock);

  void listEntries(const drogon::HttpRequestPtr& req, HttpCallback&& cb);     // GET    /v1/gym/bodyweight
  void saveEntry(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                 const std::string& dateLocal);                               // PUT    /v1/gym/bodyweight/{dateLocal}
  void deleteEntry(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                   const std::string& dateLocal);                             // DELETE /v1/gym/bodyweight/{dateLocal}
  void exportEntries(const drogon::HttpRequestPtr& req, HttpCallback&& cb);   // GET    /v1/gym/export/bodyweight

private:
  std::shared_ptr<BodyweightService> bodyweight_;
  std::shared_ptr<AuthService> auth_;
  Clock& clock_;   // the forecast gate's UTC today, and nothing else here reads it
};

}
