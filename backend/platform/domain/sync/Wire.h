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

// §9.7 ACCOUNT_ID_BYTES: the most UTF-8 bytes an account id holds.
inline constexpr std::size_t kAccountIdBytes = 64;

// §9.1: an account id is at most ACCOUNT_ID_BYTES bytes of UTF-8 and holds no character jcs escapes (a control
// character, '"' or '\').
bool isAccountId(std::string_view id);

// §9.1 Principal as every answer from authentication on, and every change, gone and not-found frame, carries it:
// `as`, the account served as, or null.
Json::Value servedAsJson(const std::optional<UserId>& principal);

// Unpadded base64url (RFC 4648 §5): a cursor's text, and any bytes a header must carry whole. Decoding answers nullopt
// for a character outside the alphabet.
std::string base64Url(std::string_view bytes);
std::optional<std::string> fromBase64Url(std::string_view text);

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
