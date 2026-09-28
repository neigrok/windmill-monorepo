#pragma once

#include "platform/domain/sync/Credentials.h"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace wm {

// The header field only the tap writes: the credentials a request sends, as the tap read them (§9.1). The tap drops the
// field from every request that sends its own.
inline constexpr char kSentCredentialsField[] = "wm-sent-credentials";

// kSentCredentialsField's value: `none`, or every credential in order, comma-separated, each its kind (`authorization`
// or `cookie`) followed, when it carries a token, by `=` and the token in unpadded base64url.
std::string sentCredentialsFieldOf(const std::vector<sync::SentCredential>& sent);
// The credentials a kSentCredentialsField value names; nullopt for any text the tap never writes.
std::optional<std::vector<sync::SentCredential>> parseSentCredentialsField(std::string_view value);

// §9.1 Credentials read as sent, on one connection. Drogon's request keeps one of two headers and drops a cookie it
// cannot parse, so a connection's bytes pass through the tap on their way to Drogon. The tap frames each HTTP/1.1
// request and hands it on in a form Drogon cannot read apart from the tap's: the request line and every header field as
// received (each value without the whitespace around it), then kSentCredentialsField naming every credential those
// fields send, then the body: as received after a Content-Length, or chunked again with its extensions dropped.
// A request the tap cannot read that way refuses the connection: an obsolete line fold, a bare CR or LF, a field name
// that is not a token, a control character in a value, two Content-Lengths or two Transfer-Encodings or one of each, a
// Transfer-Encoding other than `chunked`, a trailer field, or a head over kMaxHeadBytes.
// After the connection's first request, when it asked for an upgrade, the next byte decides: an upper-case letter begins
// another request, so the upgrade was refused and the framing goes on; anything else is a WebSocket frame, and every
// later byte passes through untouched.
class CredentialTap {
public:
  static constexpr std::size_t kMaxHeadBytes = 1 << 20;
  static constexpr std::size_t kMaxChunkLineBytes = 4096;

  // What one feed hands on to Drogon. `refuses`: this feed refused the connection, which is answered 400 and closed; a
  // refused tap hands on nothing more.
  struct Fed {
    std::string forward;
    bool refuses = false;
  };

  Fed feed(std::string_view received);

private:
  enum class Stage { head, body, chunkSize, chunkData, chunkEnd, lastChunkEnd, upgradeVerdict, passThrough, refused };

  // Each reads from pending_ at `at`, appends what it hands on to `forward`, and answers whether it can go on without
  // more bytes.
  bool readHead(std::size_t& at, std::string& forward);
  bool readBody(std::size_t& at, std::string& forward);
  bool readChunkSize(std::size_t& at, std::string& forward);
  bool readChunkData(std::size_t& at, std::string& forward);
  bool readCrlf(std::size_t& at, std::string& forward);
  bool readUpgradeVerdict(std::size_t& at, std::string& forward);

  // The request's last byte is handed on: the next is a request's, or the upgrade's verdict.
  void endRequest();
  bool refuse();

  std::string pending_;
  Stage stage_ = Stage::head;
  std::size_t headScanned_ = 0;   // bytes of the pending head already searched for its end
  std::uint64_t remaining_ = 0;   // body or chunk bytes still to hand on
  bool firstRequest_ = true;
  bool upgradeVerdictDue_ = false;
};

}
