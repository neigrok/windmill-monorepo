#pragma once

#include "platform/application/AuthService.h"
#include "platform/application/OAuthService.h"
#include "platform/application/WorkerPool.h"
#include "platform/application/sync/Admission.h"
#include "platform/application/sync/SyncLive.h"
#include "platform/application/sync/SyncService.h"
#include "platform/domain/sync/Credentials.h"
#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/Wire.h"
#include "test/SyncCorpus.h"
#include "test/platform/Fakes.h"
#include "test/platform/application/sync/SyncCorpusRunners.h"
#include "test/platform/application/sync/SyncWorld.h"

#include <json/json.h>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

// The server's readings of push/serve.json, pull/serve.json and pull/hello.json (corpus/README.md) through
// SyncService, and of live/death.json through SyncLive, over any SyncWorld. Accounts in an input, a push body's
// `account` and every answer's `as` are the corpus's aliases, which a world maps to the ids its store keeps.
// envelope/credentials.json is read by SentCredentials and resolved by AuthService, over any AuthRepository.

namespace wm::sync::test {

// A vector's `budget`: the admissions a push makes before it answers retry; none is no bound.
class CountBudget final : public PushBudget {
public:
  explicit CountBudget(std::optional<std::size_t> admissions) : admissions_(admissions) {}
  bool spent(std::size_t admitted) override { return admissions_ && admitted >= *admissions_; }

private:
  std::optional<std::size_t> admissions_;
};

// An input's credential: `credential: 'unresolved'` is one sent that resolves to no account; otherwise `account` is
// the account a sent one resolves to, or null for none sent.
inline Credential credentialOf(const SyncWorld& world, const Json::Value& input) {
  if (input["credential"] == Json::Value("unresolved")) return Credential::sent(std::nullopt);
  if (input["account"].isNull()) return Credential::none();
  return Credential::sent(world.account(input["account"].asString()));
}

// A body or frame with its `as` named by the account's alias.
inline Json::Value aliasedAs(const SyncWorld& world, Json::Value answer) {
  if (answer.isObject() && answer.isMember("as") && answer["as"].isString()) answer["as"] = world.alias(UserId{answer["as"].asString()});
  return answer;
}

inline Json::Value responseOf(const SyncWorld& world, const SyncReply& reply) {
  return object({{"status", reply.status}, {"body", aliasedAs(world, reply.body)}});
}

// A request body as the world's store names accounts: a push's string `account` by the id its alias maps to. The
// limits move PUSH_MAX_BYTES by as many bytes as that grew the body, so a vector's size boundary stays where the
// corpus drew it. Over the fakes an account is its alias, and nothing moves.
struct StoredRequest {
  std::string body;
  Limits limits;
};

inline StoredRequest storedRequest(const SyncWorld& world, const Json::Value& request, Limits limits) {
  Json::Value stored = request;
  if (stored.isObject() && stored.isMember("account") && stored["account"].isString()) stored["account"] = world.account(stored["account"].asString()).str();
  const std::string body = jcs(stored);
  limits.pushMaxBytes += body.size() - jcs(request).size();
  return StoredRequest{body, limits};
}

// §6.8's live events of every change the world's feed received: a change frame per scope an admission wrote,
// then a death event per scope it killed.
inline Json::Value liveEventsOf(SyncWorld& world, const Limits& limits) {
  Json::Value events(Json::arrayValue);
  for (const CommittedChange& change : world.feed.published) {
    for (const ScopeChange& scope : change.changed) {
      const Json::Value frame = changeFrame(change.epoch, scope.key, scope.seq, scope.digest, scope.rows, limits.liveInlineBytes);
      events.append(object({{"key", world.aliasKey(scope.key)}, {"frame", frame}}));
    }
    for (const ScopeKey& killed : change.killed) events.append(object({{"key", world.aliasKey(killed)}, {"dead", true}}));
  }
  return events;
}

// push/serve.json: §6.2 once, under the vector's budget, faults and limits, with jcs(request) as the body received.
inline Json::Value pushVector(SyncWorld& world, const Json::Value& input) {
  BlockingThread::Mark blocking;
  world.seed(input["state"]);
  const StoredRequest push = storedRequest(world, input["request"], limitsOf(input));
  const Limits& limits = push.limits;
  fake::FaultingStore::Faults faults;
  for (const Json::Value& fault : input["faults"]) {
    faults.intents.emplace(fault["n"].asUInt64(), fault["kind"].asString() == "transient" ? FaultClass::transient : FaultClass::fault);
  }
  fake::FaultingStore store(world.store(), faults);
  Admission admission(world.catalog(), store, world.feed, world.clock(), world.failures, limits);
  wm::fake::FakeClock clock;
  clock.now = input["serverNow"].asUInt64();
  SyncService service(world.catalog(), store, admission, clock);
  CountBudget budget(input.isMember("budget") ? std::optional<std::size_t>(input["budget"].asUInt64()) : std::nullopt);

  world.feed.published.clear();
  const SyncReply reply = service.push(credentialOf(world, input), push.body, budget);
  return object({{"response", responseOf(world, reply)}, {"state", world.dump()}, {"frames", liveEventsOf(world, limits)}});
}

// pull/serve.json: §6.7 once. The state joins the answer when the beforePull admissions changed it, and their
// live events when there are any.
inline Json::Value pullVector(SyncWorld& world, const Json::Value& input) {
  BlockingThread::Mark blocking;
  world.seed(input["state"]);
  const Json::Value before = world.dump();
  const Limits limits = limitsOf(input);
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures, limits);
  wm::fake::FakeClock clock;
  clock.now = input["serverNow"].asUInt64();
  SyncService service(world.catalog(), world.store(), admission, clock);

  world.feed.published.clear();
  const SyncReply reply = service.pull(credentialOf(world, input), jcs(input["request"]));
  Json::Value answer = object({{"response", responseOf(world, reply)}});
  const Json::Value after = world.dump();
  if (jcs(after) != jcs(before)) answer["state"] = after;
  const Json::Value live = liveEventsOf(world, limits);
  if (!live.empty()) answer["live"] = live;
  return answer;
}

// protocol/*.jsonl, the server's half (corpus/README.md "protocol/*.jsonl"): seed the store from the header,
// replay every HTTP exchange with its account, serverNow and inject and compare its response, apply every
// server load, and compare the final store with the end line's. Client actions and frames are the client's.
inline void protocolTranscript(SyncWorld& world, const std::vector<Json::Value>& lines) {
  BlockingThread::Mark blocking;
  world.seed(lines.front()["server"]);
  for (std::size_t i = 1; i < lines.size(); ++i) {
    const Json::Value& line = lines[i];
    if (line.isMember("http")) {
      const StoredRequest request = storedRequest(world, line["request"], Limits{});
      fake::FaultingStore::Faults faults;
      for (const Json::Value& n : line["inject"]["fault"]) faults.intents.emplace(n.asUInt64(), FaultClass::fault);
      fake::FaultingStore store(world.store(), faults);
      Admission admission(world.catalog(), store, world.feed, world.clock(), world.failures, request.limits);
      wm::fake::FakeClock clock;
      clock.now = line["serverNow"].asUInt64();
      SyncService service(world.catalog(), store, admission, clock);
      const Credential credential = credentialOf(world, line);
      const std::string http = line["http"].asString();
      CountBudget budget(line["inject"].isMember("budget") ? std::optional<std::size_t>(line["inject"]["budget"].asUInt64()) : std::nullopt);
      const SyncReply reply = http == "push" ? service.push(credential, request.body, budget)
                              : http == "pull" ? service.pull(credential, request.body)
                                               : service.hello(credential);
      corpus::checkSame(responseOf(world, reply), line["response"], __FILE__, __LINE__);
      continue;
    }
    if (line["server"].isString() && line["server"].asString() == "load") world.seed(line["state"]);
    if (line["end"].asBool()) corpus::checkSame(world.dump(), line["server"], __FILE__, __LINE__);
  }
}

// pull/hello.json: §9.2 at the vector's serverTime.
inline Json::Value helloVector(SyncWorld& world, const Json::Value& input) {
  BlockingThread::Mark blocking;
  world.seed(input["state"]);
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
  wm::fake::FakeClock clock;
  clock.now = input["serverTime"].asUInt64();
  SyncService service(world.catalog(), world.store(), admission, clock);
  return object({{"response", responseOf(world, service.hello(credentialOf(world, input)))}});
}

// live/death.json: the frame a live socket of `account`, subscribed to `scope`, receives when the scope dies
// (§6.8). The state is the one after the death, so the socket subscribes while its dead scopes are still alive,
// and the death reaches it as an admission publishes one: each dead scope's key, ascending, as killTree answers
// them. Null when no frame arrives.
inline Json::Value liveDeathVector(SyncWorld& world, const Json::Value& input) {
  BlockingThread::Mark blocking;
  Json::Value beforeDeath = input["state"];
  std::vector<ScopeKey> killed;
  for (const std::string& key : beforeDeath["scopes"].getMemberNames()) {
    Json::Value& scope = beforeDeath["scopes"][key];
    if (scope["state"].asString() != "dead") continue;
    scope["state"] = "alive";
    scope.removeMember("deadAt");
    killed.push_back(world.storeKey(key));
  }
  std::sort(killed.begin(), killed.end());
  world.seed(beforeDeath);
  SyncLive live(world.catalog(), world.store(), Limits{});
  const auto socket = std::make_shared<fake::RecordingSocket>();
  live.open(socket, world.account(input["account"].asString()));
  Json::Value refs(Json::arrayValue);
  refs.append(input["scope"]);
  live.subscribe(*socket, refs);
  CHECK_EQ(jcs(socket->frames), std::string("[]"));

  live.publish(CommittedChange{beforeDeath.isMember("epoch") ? beforeDeath["epoch"].asString() : "ep-1", {}, killed});

  CHECK(socket->frames.size() <= 1);
  return object({{"frame", socket->frames.empty() ? Json::Value(Json::nullValue) : aliasedAs(world, socket->frames[0])}});
}

// FakeTokens with a digest every byte string survives as text: a sent token need not be UTF-8, and a Postgres
// repository stores and looks up the digest.
struct HexDigestTokens final : wm::fake::FakeTokens {
  std::string digestOf(const std::string& secret) override {
    static constexpr char kHex[] = "0123456789abcdef";
    std::string digest = "d";
    for (const unsigned char byte : secret) digest.append({kHex[byte >> 4], kHex[byte & 0x0F]});
    return digest;
  }
};

// envelope/credentials.json: the principal a request is served as (§9.1). Its headers are the request's header lines as
// received. Each of `sessions` is minted into `repo` for the account its alias signs up as, and AuthService resolves
// every token.
inline Json::Value credentialsVector(AuthRepository& repo, const Json::Value& input) {
  HexDigestTokens tokens;
  wm::fake::FakeClock clock;
  wm::fake::FakeEmail email;
  wm::fake::FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, clock};
  wm::fake::FakeAccountFootprint footprint;
  wm::fake::FakeSessionRevocations revocations;
  AuthService auth(repo, email, tokens, clock, oauth, footprint, revocations, "https://windmill.works");
  std::map<std::string, std::string> aliases;
  for (const std::string& token : input["sessions"].getMemberNames()) {
    const std::string alias = input["sessions"][token].asString();
    const Email address{"credentials-" + alias + "@corpus.test"};
    const std::optional<User> existing = repo.findUserByEmail(address);
    const User user = existing ? *existing : repo.createUser(address, alias);
    repo.deleteSession(tokens.digestOf(token));
    repo.insertSession(tokens.digestOf(token), user.id, clock.now + 1'000'000, "", "", clock.now);
    aliases[user.id.str()] = alias;
  }

  HeaderOccurrences occurrences;
  for (const Json::Value& header : input["headers"]) occurrences.emplace_back(header[0].asString(), header[1].asString());
  const Credential credential = SentCredentials::fromOccurrences(occurrences).resolve([&auth](const std::string& token) -> std::optional<UserId> {
    const std::optional<User> user = auth.authenticate(token);
    return user ? std::optional(user->id) : std::nullopt;
  });
  Json::Value principal = object({{"account", credential.servedAs() ? Json::Value(aliases.at(credential.servedAs()->str())) : Json::Value()}});
  if (credential.fails()) principal["credential"] = "unresolved";
  return object({{"principal", principal}});
}

}
