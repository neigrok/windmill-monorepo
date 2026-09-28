#include "platform/adapters/http/CredentialTap.h"

#include "platform/domain/sync/Wire.h"

#include <algorithm>
#include <cctype>
#include <charconv>
#include <cstring>

namespace wm {

namespace {

using sync::SentCredential;

bool isControl(char c) {
  const auto byte = static_cast<unsigned char>(c);
  return byte < 0x20 || byte == 0x7F;
}

// RFC 9110 §5.6.2 tchar.
bool isTokenChar(char c) {
  return std::isalnum(static_cast<unsigned char>(c)) != 0 || std::strchr("!#$%&'*+-.^_`|~", c) != nullptr;
}

bool equalsIgnoringCase(std::string_view a, std::string_view b) {
  return a.size() == b.size() && std::equal(a.begin(), a.end(), b.begin(), [](char x, char y) {
           return std::tolower(static_cast<unsigned char>(x)) == std::tolower(static_cast<unsigned char>(y));
         });
}

std::string_view withoutOws(std::string_view value) {
  while (!value.empty() && (value.front() == ' ' || value.front() == '\t')) value.remove_prefix(1);
  while (!value.empty() && (value.back() == ' ' || value.back() == '\t')) value.remove_suffix(1);
  return value;
}

std::string_view kindName(SentCredential::Kind kind) {
  return kind == SentCredential::Kind::authorization ? "authorization" : "cookie";
}

// A request's head as the tap hands it on, and how its body is framed; nullopt when the tap cannot read it the way
// Drogon would.
struct Head {
  std::string forward;
  std::optional<std::uint64_t> contentLength;
  bool chunked = false;
  bool asksUpgrade = false;

  static std::optional<Head> read(std::string_view head) {
    Head read;
    sync::HeaderFields fields;
    std::size_t at = 0;
    for (bool requestLine = true;; requestLine = false) {
      const std::size_t end = head.find("\r\n", at);
      const std::string_view line = head.substr(at, end - at);
      at = end + 2;
      if (line.empty() && !requestLine) break;
      if (requestLine) {
        if (line.empty() || std::any_of(line.begin(), line.end(), isControl)) return std::nullopt;
        read.forward.append(line).append("\r\n");
        continue;
      }
      const std::size_t colon = line.find(':');
      if (colon == std::string_view::npos || colon == 0) return std::nullopt;
      const std::string_view name = line.substr(0, colon);
      const std::string_view value = withoutOws(line.substr(colon + 1));
      if (!std::all_of(name.begin(), name.end(), isTokenChar)) return std::nullopt;
      if (std::any_of(value.begin(), value.end(), [](char c) { return c != '\t' && isControl(c); })) return std::nullopt;
      if (equalsIgnoringCase(name, kSentCredentialsField)) continue;
      if (equalsIgnoringCase(name, "content-length")) {
        // Digits alone: from_chars takes no sign and no space, and stops at the first byte that is not one.
        std::uint64_t length = 0;
        const auto [parsed, error] = std::from_chars(value.data(), value.data() + value.size(), length);
        if (read.contentLength || error != std::errc{} || parsed != value.data() + value.size()) return std::nullopt;
        read.contentLength = length;
      }
      if (equalsIgnoringCase(name, "transfer-encoding")) {
        if (read.chunked || value != "chunked") return std::nullopt;
        read.chunked = true;
      }
      if (equalsIgnoringCase(name, "upgrade")) read.asksUpgrade = true;
      read.forward.append(name).append(": ").append(value).append("\r\n");
      fields.emplace_back(name, value);
    }
    if (read.contentLength && read.chunked) return std::nullopt;
    read.forward.append(kSentCredentialsField).append(": ").append(sentCredentialsFieldOf(sync::sentCredentialsOf(fields))).append("\r\n\r\n");
    return read;
  }
};

}

std::string sentCredentialsFieldOf(const std::vector<SentCredential>& sent) {
  if (sent.empty()) return "none";
  std::string value;
  for (const SentCredential& credential : sent) {
    if (!value.empty()) value += ',';
    value += kindName(credential.kind);
    if (credential.token) value.append("=").append(sync::base64Url(*credential.token));
  }
  return value;
}

std::optional<std::vector<SentCredential>> parseSentCredentialsField(std::string_view value) {
  std::vector<SentCredential> sent;
  if (value == "none") return sent;
  while (true) {
    const std::size_t end = value.find(',');
    const std::string_view entry = value.substr(0, end);
    const std::size_t equals = entry.find('=');
    const std::string_view kind = entry.substr(0, equals);
    SentCredential credential{SentCredential::Kind::authorization, std::nullopt};
    if (kind == kindName(SentCredential::Kind::cookie)) credential.kind = SentCredential::Kind::cookie;
    else if (kind != kindName(SentCredential::Kind::authorization)) return std::nullopt;
    if (equals != std::string_view::npos) {
      credential.token = sync::fromBase64Url(entry.substr(equals + 1));
      if (!credential.token || credential.token->empty()) return std::nullopt;
    }
    sent.push_back(std::move(credential));
    if (end == std::string_view::npos) return sent;
    value.remove_prefix(end + 1);
  }
}

CredentialTap::Fed CredentialTap::feed(std::string_view received) {
  if (stage_ == Stage::refused) return {};
  if (stage_ == Stage::passThrough) return {std::string(received), false};
  pending_.append(received);
  Fed fed;
  std::size_t at = 0;
  for (bool goesOn = true; goesOn && at < pending_.size();) {
    switch (stage_) {
      case Stage::head: goesOn = readHead(at, fed.forward); break;
      case Stage::body: goesOn = readBody(at, fed.forward); break;
      case Stage::chunkSize: goesOn = readChunkSize(at, fed.forward); break;
      case Stage::chunkData: goesOn = readChunkData(at, fed.forward); break;
      case Stage::chunkEnd:
      case Stage::lastChunkEnd: goesOn = readCrlf(at, fed.forward); break;
      case Stage::upgradeVerdict: goesOn = readUpgradeVerdict(at, fed.forward); break;
      case Stage::passThrough:
      case Stage::refused: goesOn = false; break;
    }
  }
  fed.refuses = stage_ == Stage::refused;
  pending_.erase(0, fed.refuses ? pending_.size() : at);
  return fed;
}

bool CredentialTap::readHead(std::size_t& at, std::string& forward) {
  // The end may straddle the bytes searched before and the ones just received.
  const std::size_t end = pending_.find("\r\n\r\n", at + (headScanned_ >= 3 ? headScanned_ - 3 : 0));
  if (end == std::string::npos) {
    headScanned_ = pending_.size() - at;
    return headScanned_ > kMaxHeadBytes ? refuse() : false;
  }
  const std::string_view text(pending_.data() + at, end + 4 - at);
  const std::optional<Head> head = text.size() > kMaxHeadBytes ? std::nullopt : Head::read(text);
  if (!head) return refuse();
  forward += head->forward;
  at = end + 4;
  headScanned_ = 0;
  upgradeVerdictDue_ = firstRequest_ && head->asksUpgrade;
  firstRequest_ = false;
  remaining_ = head->contentLength.value_or(0);
  if (head->chunked) stage_ = Stage::chunkSize;
  else if (remaining_ > 0) stage_ = Stage::body;
  else endRequest();
  return true;
}

bool CredentialTap::readBody(std::size_t& at, std::string& forward) {
  const std::size_t taken = static_cast<std::size_t>(std::min<std::uint64_t>(remaining_, pending_.size() - at));
  forward.append(pending_, at, taken);
  at += taken;
  remaining_ -= taken;
  if (remaining_ > 0) return false;
  endRequest();
  return true;
}

bool CredentialTap::readChunkSize(std::size_t& at, std::string& forward) {
  const std::size_t end = pending_.find("\r\n", at);
  if (end == std::string::npos) return pending_.size() - at > kMaxChunkLineBytes ? refuse() : false;
  const std::string_view line(pending_.data() + at, end - at);
  const std::size_t digits = std::min(line.find_first_not_of("0123456789abcdefABCDEF"), line.size());
  const std::string_view extensions = withoutOws(line.substr(digits));
  std::uint64_t size = 0;
  std::from_chars(line.data(), line.data() + digits, size, 16);
  const bool readable = line.size() <= kMaxChunkLineBytes && digits > 0 && digits <= 15 &&
                        (extensions.empty() || extensions.front() == ';') &&
                        std::none_of(line.begin(), line.end(), [](char c) { return c != '\t' && isControl(c); });
  if (!readable) return refuse();
  char hex[16];
  forward.append(hex, std::to_chars(hex, hex + sizeof hex, size, 16).ptr).append("\r\n");
  at = end + 2;
  remaining_ = size;
  stage_ = size > 0 ? Stage::chunkData : Stage::lastChunkEnd;
  return true;
}

bool CredentialTap::readChunkData(std::size_t& at, std::string& forward) {
  const std::size_t taken = static_cast<std::size_t>(std::min<std::uint64_t>(remaining_, pending_.size() - at));
  forward.append(pending_, at, taken);
  at += taken;
  remaining_ -= taken;
  if (remaining_ > 0) return false;
  stage_ = Stage::chunkEnd;
  return true;
}

bool CredentialTap::readCrlf(std::size_t& at, std::string& forward) {
  if (pending_.size() - at < 2) return false;
  if (pending_.compare(at, 2, "\r\n") != 0) return refuse();
  forward += "\r\n";
  at += 2;
  if (stage_ == Stage::chunkEnd) stage_ = Stage::chunkSize;
  else endRequest();
  return true;
}

bool CredentialTap::readUpgradeVerdict(std::size_t& at, std::string& forward) {
  if (pending_[at] >= 'A' && pending_[at] <= 'Z') {
    stage_ = Stage::head;
    return true;
  }
  stage_ = Stage::passThrough;
  forward.append(pending_, at);
  at = pending_.size();
  return false;
}

void CredentialTap::endRequest() {
  stage_ = upgradeVerdictDue_ ? Stage::upgradeVerdict : Stage::head;
  upgradeVerdictDue_ = false;
}

bool CredentialTap::refuse() {
  stage_ = Stage::refused;
  return false;
}

}
