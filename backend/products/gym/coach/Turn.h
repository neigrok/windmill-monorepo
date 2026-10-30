#pragma once

#include "platform/ai_installations/AiInstallations.h"
#include "platform/domain/Auth.h"

#include <json/json.h>

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

// A Coach turn as the server keeps it (docs/foundation/mobile/gym_coach.md): the open body in
// bounds, the seat it runs against, and the in-memory record the loop writes and the stream reads.

namespace wm::gym::coach {

// D-3: the catalog versions a turn may open with, served side by side; `catalog/N` names version N.
constexpr int kOldestCatalog = 1;
constexpr int kNewestCatalog = 2;

// Appendix A.
constexpr int kMaxModelCalls = 8;
constexpr int kMaxAbilityCalls = 12;
constexpr int kMaxAdds = 6;
constexpr std::size_t kMaxQuestionBytes = 8000;
constexpr std::size_t kMaxPicturesPerMessage = 1;
constexpr std::size_t kContextTurns = 24;
constexpr std::size_t kContextBytes = 24'000;
constexpr std::size_t kContextPictures = 2;
constexpr std::size_t kContextReadBytes = 64 * 1024;
constexpr std::size_t kModelPictureBytes = 1024 * 1024;
constexpr std::size_t kToolResultBytes = 16 * 1024;
constexpr std::size_t kOpenBodyBytes = 4 * 1024 * 1024;
// A results body answers at most one batch of MAX_ABILITY_CALLS results, each within its bound.
constexpr std::size_t kResultsBodyBytes = kMaxAbilityCalls * kToolResultBytes + 16 * 1024;
constexpr std::chrono::seconds kCallResultTimeout{60};
constexpr std::chrono::minutes kTurnLinger{10};
// D-8: a turn id seeds every record id the turn mints (G-7), so it fits the gym seed bound.
constexpr std::size_t kTurnIdMaxLength = 58;
constexpr std::size_t kTurnIdMinLength = 8;

// D-10: whose store a turn runs against.
enum class Seat { anon, bound };
std::string_view nameOf(Seat seat);

// The seat and who pays for it (§7.1): the account of a `bound` turn, the installation of an `anon`
// one. `address` is the canonical client address an anonymous open counts against its IP limit.
struct TurnPrincipal {
  Seat seat = Seat::anon;
  std::optional<User> account;
  std::optional<AiInstallationPrincipal> installation;
  std::string address;

  // The registry's owner key: the account id, or the installation id.
  std::string id() const;
};

struct TurnPicture {
  std::string id;
  std::string mediaType;
  std::string data;  // base64, as the body carried it
};

struct TurnHistoryLine {
  std::string role;  // lifter | coach
  std::string text;
};

struct TurnContextRead {
  std::string name;
  Json::Value input;
  Json::Value result;
};

// §6.2: the open body, in bounds. `digest` is the SHA-256 of the body's JCS: a seen turnId resumes
// under the same digest and conflicts under another.
struct TurnOpen {
  int catalog = kNewestCatalog;
  std::string turnId;
  std::string question;
  std::vector<TurnPicture> pictures;
  std::vector<TurnHistoryLine> history;
  std::vector<TurnContextRead> context;
  std::string digest;
};

// §6.2 admission steps 1 and 2: `code` is `coach-update-required` for a catalog version the server
// does not serve and `coach-bad-request` for a body out of shape or bounds.
struct TurnOpenRead {
  std::optional<TurnOpen> open;
  std::string code;
};
TurnOpenRead readTurnOpen(const Json::Value& body);

// §4.4: `running`, then one terminal state.
enum class TurnState { running, completed, declined, failed, stopped, interrupted };
std::string_view nameOf(TurnState state);
bool terminal(TurnState state);

// §4.3: one ability call the model made, the id it gave it, and one batch of them.
struct TurnCall {
  std::string callId;
  std::string name;
  Json::Value input;
};

struct TurnBatch {
  int number = 0;
  std::vector<TurnCall> calls;

  Json::Value json() const;
};

// §6.4: what the phone answered one call with.
struct TurnCallResult {
  std::string callId;
  bool ok = false;
  Json::Value result;
  std::string code;
};

// §6.4: a results body in shape — no more results than a batch can hold, each carrying exactly
// its keys and within TOOL_RESULT_BYTES; `code` is `coach-bad-request` otherwise.
struct TurnResultsRead {
  int batch = 0;
  std::vector<TurnCallResult> results;
  std::string code;
};
TurnResultsRead readTurnResults(const Json::Value& body);

// §6.3: where a turn's events go — the open stream. `terminal` closes it after the frame.
struct TurnSink {
  virtual ~TurnSink() = default;
  virtual void send(const std::string& event, const Json::Value& data, bool terminal) = 0;
};

// What the service answers a results body with (§6.4): the body that answered a batch, sent again,
// is a `replay` (204); any other body that does not answer the pending batch is out of `order` (409).
enum class ResultsAnswer { accepted, replay, order };

// The record of one running or lingering turn. Every method is safe from any thread: the loop
// writes text and batches on a worker, the stream attaches on an IO thread, results and Stop arrive
// on HTTP workers. Text is kept whole so a stream that attaches late, or again, reads everything.
class Turn {
public:
  Turn(TurnPrincipal principal, TurnOpen open, std::uint64_t openedAtMs);

  const TurnPrincipal& principal() const { return principal_; }
  const TurnOpen& open() const { return open_; }
  const std::string& id() const { return open_.turnId; }
  std::uint64_t openedAtMs() const { return openedAtMs_; }

  // The loop's side.
  void appendText(const std::string& delta);
  // Numbers the batch, holds it pending and sends it as one `calls` event — or nothing once Stop
  // was requested: the check and the send are one step under the lock, so no batch follows a Stop.
  std::optional<TurnBatch> sendBatch(std::vector<TurnCall> calls);
  // Blocks until the pending batch is answered, Stop is requested, or `timeout` passes; the
  // results come back in the batch's call order. Nullopt is a timeout or a Stop.
  std::optional<std::vector<TurnCallResult>> awaitResults(std::chrono::milliseconds timeout);
  void end(TurnState state, bool truncated, Json::Value allowance, std::string errorCode,
           std::uint64_t endedAtMs);

  // The phone's side.
  ResultsAnswer answer(int batch, std::vector<TurnCallResult> results, const std::string& bodyDigest);
  void requestStop();
  bool stopRequested() const;
  // Replaces the stream: another stream still open hears `error coach-stream-replaced` and closes
  // first. A resume opens with `snapshot`; a fresh open catches up on what streamed before the
  // stream attached. An ended turn then gets its terminal frame and closes.
  void attach(std::shared_ptr<TurnSink> sink, bool resume);

  TurnState state() const;
  std::string text() const;
  std::optional<std::uint64_t> endedAtMs() const;
  Json::Value snapshot() const;

private:
  void publish(const std::string& event, const Json::Value& data, bool terminal);
  Json::Value snapshotUnlocked() const;
  Json::Value terminalData() const;
  bool answered() const;

  TurnPrincipal principal_;
  TurnOpen open_;
  std::uint64_t openedAtMs_;
  mutable std::mutex mutex_;
  std::condition_variable results_;
  std::shared_ptr<TurnSink> sink_;
  std::string text_;
  TurnState state_ = TurnState::running;
  bool truncated_ = false;
  std::string errorCode_;
  Json::Value allowance_{Json::nullValue};
  std::optional<std::uint64_t> endedAtMs_;
  bool stopRequested_ = false;
  int batches_ = 0;
  std::optional<TurnBatch> pending_;
  std::optional<std::vector<TurnCallResult>> pendingResults_;
  std::map<int, std::string> answeredDigests_;  // batch number → the body digest that answered it
};

}
