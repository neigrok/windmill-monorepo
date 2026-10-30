#include "products/gym/coach/Turn.h"

#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/Jcs.h"
#include "products/gym/adapters/http/CoachImage.h"

#include <drogon/utils/Utilities.h>

#include <algorithm>
#include <utility>

namespace wm::gym::coach {

namespace {

constexpr const char* kBadRequest = "coach-bad-request";

bool turnIdShape(const std::string& id) {
  if (id.size() < kTurnIdMinLength || id.size() > kTurnIdMaxLength) return false;
  return std::all_of(id.begin(), id.end(), [](char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
  });
}

// §4.1 step 3: the four list reads, and from catalog/2 the open workout's get_session.
bool isContextRead(const std::string& name, int catalog) {
  if (name == "get_session") return catalog >= 2;
  return name == "list_sessions" || name == "list_notes" || name == "list_exercises" || name == "list_routines";
}

// `catalog/N` for a version the server serves; nothing for any other.
std::optional<int> servedCatalog(const std::string& name) {
  for (int version = kOldestCatalog; version <= kNewestCatalog; ++version)
    if (name == "catalog/" + std::to_string(version)) return version;
  return std::nullopt;
}

// The body's JCS, or nothing for a body JCS cannot encode (a non-finite number, a non-UTF-8 string).
std::optional<std::string> canonical(const Json::Value& value) {
  try { return sync::jcs(value); } catch (const sync::JsonError&) { return std::nullopt; }
}

std::optional<std::vector<TurnPicture>> readPictures(const Json::Value& pictures) {
  std::vector<TurnPicture> out;
  if (pictures.isNull()) return out;
  if (!pictures.isArray() || pictures.size() > kContextPictures) return std::nullopt;
  for (const Json::Value& picture : pictures) {
    if (!picture.isObject() || !picture["id"].isString() || !picture["mediaType"].isString() || !picture["data"].isString())
      return std::nullopt;
    const std::string data = picture["data"].asString();
    if (data.empty() || data.size() > 4 * ((kModelPictureBytes + 2) / 3) + 4) return std::nullopt;
    const std::string bytes = drogon::utils::base64Decode(data);
    if (bytes.size() > kModelPictureBytes || drogon::utils::base64Encode(bytes) != data) return std::nullopt;
    if (!decodeCoachImage(picture["id"].asString(), picture["mediaType"].asString(), bytes)) return std::nullopt;
    out.push_back({picture["id"].asString(), picture["mediaType"].asString(), data});
  }
  return out;
}

std::optional<std::vector<TurnHistoryLine>> readHistory(const Json::Value& history) {
  std::vector<TurnHistoryLine> out;
  if (history.isNull()) return out;
  if (!history.isArray() || history.size() > 2 * kContextTurns) return std::nullopt;
  std::size_t bytes = 0;
  for (const Json::Value& line : history) {
    if (!line.isObject() || !line["role"].isString() || !line["text"].isString()) return std::nullopt;
    const std::string role = line["role"].asString();
    if (role != "lifter" && role != "coach") return std::nullopt;
    bytes += line["text"].asString().size();
    if (bytes > kContextBytes) return std::nullopt;
    out.push_back({role, line["text"].asString()});
  }
  return out;
}

std::optional<std::vector<TurnContextRead>> readContext(const Json::Value& context, int catalog) {
  std::vector<TurnContextRead> out;
  if (context.isNull()) return out;
  if (!context.isArray() || context.size() > 5) return std::nullopt;
  std::size_t bytes = 0;
  for (const Json::Value& read : context) {
    if (!read.isObject() || !read["name"].isString() || !isContextRead(read["name"].asString(), catalog)) return std::nullopt;
    if (!read["input"].isObject() || !read["result"].isObject()) return std::nullopt;
    for (const TurnContextRead& seen : out)
      if (seen.name == read["name"].asString()) return std::nullopt;
    const std::optional<std::string> result = canonical(read["result"]);
    if (!result) return std::nullopt;
    bytes += result->size();
    if (bytes > kContextReadBytes) return std::nullopt;
    out.push_back({read["name"].asString(), read["input"], read["result"]});
  }
  return out;
}

bool resultShape(const Json::Value& result, TurnCallResult& out) {
  if (!result.isObject() || !result["callId"].isString() || !result["ok"].isBool()) return false;
  out.callId = result["callId"].asString();
  out.ok = result["ok"].asBool();
  for (const std::string& key : result.getMemberNames())
    if (key != "callId" && key != "ok" && key != (out.ok ? "result" : "code")) return false;
  if (out.ok) {
    if (!result["result"].isObject()) return false;
    const std::optional<std::string> bytes = canonical(result["result"]);
    if (!bytes || bytes->size() > kToolResultBytes) return false;
    out.result = result["result"];
    return true;
  }
  if (!result["code"].isString() || result["code"].asString().empty() || result["code"].asString().size() > 64) return false;
  out.code = result["code"].asString();
  return true;
}

}  // namespace

std::string_view nameOf(Seat seat) { return seat == Seat::anon ? "anon" : "bound"; }

std::string TurnPrincipal::id() const {
  if (account) return account->id.str();
  if (installation) return installation->id();
  return std::string();
}

std::string_view nameOf(TurnState state) {
  switch (state) {
    case TurnState::running: return "running";
    case TurnState::completed: return "completed";
    case TurnState::declined: return "declined";
    case TurnState::failed: return "failed";
    case TurnState::stopped: return "stopped";
    case TurnState::interrupted: return "interrupted";
  }
  return "failed";
}

bool terminal(TurnState state) { return state != TurnState::running; }

Json::Value TurnBatch::json() const {
  Json::Value out(Json::objectValue);
  out["batch"] = number;
  out["calls"] = Json::Value(Json::arrayValue);
  for (const TurnCall& call : calls) {
    Json::Value entry(Json::objectValue);
    entry["callId"] = call.callId;
    entry["name"] = call.name;
    entry["input"] = call.input;
    out["calls"].append(entry);
  }
  return out;
}

TurnOpenRead readTurnOpen(const Json::Value& body) {
  if (!body.isObject() || !body["catalog"].isString() || body["catalog"].asString().rfind("catalog/", 0) != 0)
    return {std::nullopt, kBadRequest};
  const std::optional<int> catalog = servedCatalog(body["catalog"].asString());
  if (!catalog) return {std::nullopt, "coach-update-required"};
  if (!body["turnId"].isString() || !turnIdShape(body["turnId"].asString())) return {std::nullopt, kBadRequest};
  if (!body["question"].isString() || body["question"].asString().size() > kMaxQuestionBytes) return {std::nullopt, kBadRequest};
  for (const std::string& key : body.getMemberNames())
    if (key != "catalog" && key != "turnId" && key != "question" && key != "pictures" && key != "history" && key != "context")
      return {std::nullopt, kBadRequest};
  const auto pictures = readPictures(body["pictures"]);
  const auto history = readHistory(body["history"]);
  const auto context = readContext(body["context"], *catalog);
  const std::optional<std::string> canon = canonical(body);
  if (!pictures || !history || !context || !canon) return {std::nullopt, kBadRequest};
  const std::string question = body["question"].asString();
  if (question.find_first_not_of(" \t\r\n") == std::string::npos && pictures->empty()) return {std::nullopt, kBadRequest};
  TurnOpen open{*catalog, body["turnId"].asString(), question, *pictures, *history, *context, sync::sha256(*canon).hex()};
  return {std::move(open), {}};
}

TurnResultsRead readTurnResults(const Json::Value& body) {
  TurnResultsRead out;
  if (!body.isObject() || !body["batch"].isInt() || body["batch"].asInt() < 1 || !body["results"].isArray() ||
      body["results"].size() > kMaxAbilityCalls || body.size() != 2) {
    out.code = kBadRequest;
    return out;
  }
  out.batch = body["batch"].asInt();
  for (const Json::Value& result : body["results"]) {
    TurnCallResult read;
    if (!resultShape(result, read)) {
      out.code = kBadRequest;
      return out;
    }
    out.results.push_back(std::move(read));
  }
  return out;
}

Turn::Turn(TurnPrincipal principal, TurnOpen open, std::uint64_t openedAtMs)
    : principal_(std::move(principal)), open_(std::move(open)), openedAtMs_(openedAtMs) {}

void Turn::appendText(const std::string& delta) {
  std::lock_guard lock(mutex_);
  if (delta.empty() || terminal(state_)) return;
  text_ += delta;
  Json::Value data(Json::objectValue);
  data["delta"] = delta;
  publish("text", data, false);
}

std::optional<TurnBatch> Turn::sendBatch(std::vector<TurnCall> calls) {
  std::lock_guard lock(mutex_);
  if (stopRequested_) return std::nullopt;
  TurnBatch batch{++batches_, std::move(calls)};
  pending_ = batch;
  pendingResults_.reset();
  publish("calls", batch.json(), false);
  return batch;
}

std::optional<std::vector<TurnCallResult>> Turn::awaitResults(std::chrono::milliseconds timeout) {
  std::unique_lock lock(mutex_);
  results_.wait_for(lock, timeout, [this] { return pendingResults_.has_value() || stopRequested_; });
  pending_.reset();
  if (!pendingResults_) return std::nullopt;
  std::vector<TurnCallResult> results = std::move(*pendingResults_);
  pendingResults_.reset();
  return results;
}

void Turn::end(TurnState state, bool truncated, Json::Value allowance, std::string errorCode,
               std::uint64_t endedAtMs) {
  std::lock_guard lock(mutex_);
  if (terminal(state_)) return;
  state_ = state;
  truncated_ = truncated;
  allowance_ = std::move(allowance);
  errorCode_ = std::move(errorCode);
  endedAtMs_ = endedAtMs;
  pending_.reset();
  publish(state_ == TurnState::failed ? "error" : "done", terminalData(), true);
  results_.notify_all();
}

bool Turn::answered() const { return pendingResults_.has_value(); }

ResultsAnswer Turn::answer(int batch, std::vector<TurnCallResult> results, const std::string& bodyDigest) {
  std::lock_guard lock(mutex_);
  const auto earlier = answeredDigests_.find(batch);
  if (earlier != answeredDigests_.end()) return earlier->second == bodyDigest ? ResultsAnswer::replay : ResultsAnswer::order;
  if (!pending_ || pending_->number != batch || answered()) return ResultsAnswer::order;
  if (results.size() != pending_->calls.size()) return ResultsAnswer::order;
  std::vector<TurnCallResult> ordered;
  for (const TurnCall& call : pending_->calls) {
    const auto result = std::find_if(results.begin(), results.end(),
                                     [&](const TurnCallResult& answer) { return answer.callId == call.callId; });
    if (result == results.end()) return ResultsAnswer::order;
    ordered.push_back(*result);
  }
  answeredDigests_[batch] = bodyDigest;
  pendingResults_ = std::move(ordered);
  results_.notify_all();
  return ResultsAnswer::accepted;
}

void Turn::requestStop() {
  std::lock_guard lock(mutex_);
  stopRequested_ = true;
  results_.notify_all();
}

bool Turn::stopRequested() const {
  std::lock_guard lock(mutex_);
  return stopRequested_;
}

void Turn::attach(std::shared_ptr<TurnSink> sink, bool resume) {
  std::lock_guard lock(mutex_);
  if (sink_ && sink_ != sink) {
    Json::Value replaced(Json::objectValue);
    replaced["code"] = "coach-stream-replaced";
    publish("error", replaced, true);
  }
  sink_ = std::move(sink);
  if (resume) {
    publish("snapshot", snapshotUnlocked(), false);
  } else {
    if (!text_.empty()) {
      Json::Value data(Json::objectValue);
      data["delta"] = text_;
      publish("text", data, false);
    }
    if (pending_ && !answered()) publish("calls", pending_->json(), false);
  }
  if (terminal(state_)) publish(state_ == TurnState::failed ? "error" : "done", terminalData(), true);
}

TurnState Turn::state() const {
  std::lock_guard lock(mutex_);
  return state_;
}

std::string Turn::text() const {
  std::lock_guard lock(mutex_);
  return text_;
}

std::optional<std::uint64_t> Turn::endedAtMs() const {
  std::lock_guard lock(mutex_);
  return endedAtMs_;
}

Json::Value Turn::snapshot() const {
  std::lock_guard lock(mutex_);
  return snapshotUnlocked();
}

Json::Value Turn::snapshotUnlocked() const {
  Json::Value out(Json::objectValue);
  out["text"] = text_;
  out["state"] = std::string(nameOf(state_));
  if (pending_ && !answered()) out["calls"] = pending_->json();
  return out;
}

Json::Value Turn::terminalData() const {
  Json::Value data(Json::objectValue);
  if (state_ == TurnState::failed) {
    data["code"] = errorCode_;
    return data;
  }
  data["state"] = std::string(nameOf(state_));
  if (truncated_) data["truncated"] = true;
  data["allowance"] = allowance_;
  return data;
}

void Turn::publish(const std::string& event, const Json::Value& data, bool terminal) {
  if (!sink_) return;
  sink_->send(event, data, terminal);
  if (terminal) sink_.reset();
}

}
