#pragma once

#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/Record.h"
#include "platform/domain/sync/Scope.h"

#include <json/json.h>

#include <cstddef>
#include <cstdint>
#include <exception>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace wm::sync {

// §9.6: the engine's refusal codes. A product adds its own (Appendix A).
namespace code {
inline const std::string notFound = "not-found";
inline const std::string scopeDead = "scope-dead";
inline const std::string forbidden = "forbidden";
inline const std::string invalid = "invalid";
inline const std::string tooLarge = "too-large";
inline const std::string clockSkew = "clock-skew";
inline const std::string idTaken = "id-taken";
inline const std::string idSpent = "id-spent";
inline const std::string unknownRecord = "unknown-record";
inline const std::string recordDead = "record-dead";
inline const std::string parentDead = "parent-dead";
inline const std::string stale = "stale";
inline const std::string cap = "cap";
inline const std::string baseUnknown = "base-unknown";
inline const std::string requestConflict = "request-conflict";
inline const std::string requestRunning = "request-running";
inline const std::string internal = "internal";
}

// D-16: a refused intent's code, and its detail when the code carries one (null otherwise).
struct Refused {
  std::string code;
  Json::Value detail;
};

// A refusal raised by any step of admission, a product's check or command included. The pipeline stops
// at it and answers it at step R (§6.1).
struct Refusal : std::exception {
  Refused refused;

  explicit Refusal(std::string code, Json::Value detail = Json::Value()) : refused{std::move(code), std::move(detail)} {}
  const char* what() const noexcept override { return refused.code.c_str(); }
};

// D-19: holds iff the stored register's stamp is `stamp`, or the register is unset and `stamp` is null.
struct Guard {
  std::string t;
  RecordId id;
  std::string field;
  std::optional<Stamp> stamp;
};

// D-20: a named server function with its raw arguments.
struct Cmd {
  std::string name;
  Json::Value args;
};

// D-13: what admission admits atomically, into the scope its reference names (§9.1 ScopeRef).
struct Intent {
  std::string scope;
  std::vector<Delta> d;
  std::vector<Guard> guard;
  std::optional<Cmd> cmd;
  std::optional<std::string> gestureId;
};

// D-20: one write-map entry: the record a command wrote or resolved to, the id it mapped from, its born,
// and the stamp of every field it wrote. Stamps a command leaves unset are the first join pass's (§6.1
// step 9).
struct WriteEntry {
  std::string t;
  RecordId id;
  std::optional<RecordId> from;
  std::optional<Stamp> born;
  std::map<std::string, Stamp> f;

  Json::Value toJson() const;
};

// §9.3 Result without its n: {s: 'ok', seq, write?, detail?} or {s: 'refused', code, detail?}. `write` is
// present, possibly empty, iff the intent carried a command.
Json::Value okResult(Seq seq, const std::optional<std::vector<WriteEntry>>& write, const Json::Value& detail);
Json::Value refusedResult(const Refused&);

// D-18 and §9.4: where a pull resumes. Wire: unpadded base64url of jcs({e, m, s, k?, a?}).
struct Cursor {
  std::string epoch;
  bool live = false;
  Seq seq = 0;
  std::optional<std::pair<std::string, RecordId>> key;  // the last row's [type, id]
  std::optional<Seq> asOf;                         // present iff booting, at least seq

  std::string encode() const;
  // Strict: nullopt unless the text is the canonical encoding of a cursor of this shape.
  static std::optional<Cursor> decode(std::string_view text);
};

// §6.8 and §9.5: {op: 'change', scope, epoch, seq, digest, rows?} for the scope's own reference, rows
// sorted by type then id, and left out when their JCS is over `inlineLimit` bytes.
Json::Value changeFrame(const std::string& epoch, const ScopeKey& scope, Seq seq, const Digest256& digest, std::vector<Json::Value> rows,
                        std::size_t inlineLimit);

// §6.2: digest(intent) = sha256(jcs(intent)), over the intent as the request carried it; and §6.3's
// digest of a server-origin call, sha256(jcs({tool, args})).
Digest256 intentDigest(const Json::Value& intent);

// §9.1 Integers: every integer on the wire is a JSON safe integer, at most 2^53 − 1 in magnitude.
bool isSafeInteger(const Json::Value& value);

// Appendix B and §9.7: the constants the server applies. A test may shrink one for one call.
struct Limits {
  Ms maxSkewMs = 300'000;
  int kPoison = 3;
  Ms lockTimeoutMs = 2'000;
  Ms requestLeaseMs = 60'000;
  std::size_t maxRecordBytes = 1'048'576;
  std::size_t pushMaxIntents = 64;
  std::size_t pushMaxBytes = 2'097'152;
  Ms pushWorkMs = 50;
  std::size_t pullPageBytes = 1'048'576;
  std::size_t pullMaxScopes = 64;
  std::size_t pullMaxBytes = 65'536;
  std::size_t liveFrameBytes = 131'072;
  std::size_t liveInlineBytes = 65'536;
  std::size_t mergeWorkCells = 4'194'304;
};

}
