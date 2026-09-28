#include "products/probe/adapters/http/DevApi.h"

#include "platform/adapters/http/JsonReply.h"
#include "platform/adapters/http/RateLimiter.h"  // clientIp
#include "platform/adapters/json/JsonText.h"
#include "platform/adapters/postgres/PgSyncStore.h"
#include "platform/domain/Auth.h"

#include <optional>
#include <string>
#include <utility>

namespace wm::probe {

DevApi::DevApi(AuthService& auth, AuthRepository& links, TokenGenerator& tokens, Clock& clock, sync::SyncStore& store)
    : auth_(auth), links_(links), tokens_(tokens), clock_(clock), store_(store) {}

void DevApi::signIn(const drogon::HttpRequestPtr& req, Reply&& reply) {
  const Json::Value body = parse(std::string(req->body()));
  const std::optional<Email> email = body.isObject() && body["email"].isString() ? parseEmail(body["email"].asString()) : std::nullopt;
  if (!email) return reply(error(drogon::k400BadRequest, "sign-in is {email}, a valid address"));

  // A magic link minted and spent at once, so the account and its session come from AuthService's own sign-in.
  const MintedToken link = tokens_.mint();
  const UnixMs now = clock_.nowMs();
  links_.insertLink(link.digest, tokens_.digestOf(tokens_.mintCode()), *email, now, linkExpiry(now), "");
  const AuthService::Completion completion =
      auth_.completeLink(link.secret, SessionContext{req->getHeader("user-agent"), clientIp(req)});
  if (!completion.signedIn) return reply(error(drogon::k500InternalServerError, "the dev link signed nobody in"));

  Json::Value answer(Json::objectValue);
  answer["account"] = completion.signedIn->user.id.str();
  answer["token"] = completion.signedIn->sessionSecret;
  reply(jsonResponse(answer));
}

void DevApi::regenerateEpoch(Reply&& reply) {
  const std::unique_ptr<sync::SyncTxn> txn = store_.begin(sync::TxnMode::write);
  const pqxx::result rows =
      sync::sqlOf(*txn).exec("update sync_meta set epoch = replace(gen_random_uuid()::text, '-', '') returning epoch");
  txn->commit();

  Json::Value answer(Json::objectValue);
  answer["epoch"] = rows[0][0].as<std::string>();
  reply(jsonResponse(answer));
}

void registerDevRoutes(drogon::HttpAppFramework& app, const std::shared_ptr<DevApi>& api) {
  app.registerHandler(
      "/v1/dev/sign-in", [api](const drogon::HttpRequestPtr& req, DevApi::Reply&& reply) { api->signIn(req, std::move(reply)); }, {drogon::Post});
  app.registerHandler(
      "/v1/dev/sync/epoch", [api](const drogon::HttpRequestPtr&, DevApi::Reply&& reply) { api->regenerateEpoch(std::move(reply)); }, {drogon::Post});
}

}
