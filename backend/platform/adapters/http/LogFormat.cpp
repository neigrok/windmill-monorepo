#include "platform/adapters/http/LogFormat.h"

#include <algorithm>
#include <cctype>
#include <cstddef>
#include <string_view>
#include <set>

namespace wm {

namespace {
constexpr char kHexDigits[] = "0123456789ABCDEF";

// The routes whose NEXT path segment is a live credential.
constexpr std::string_view kSecretSegmentAfter[] = {"/v1/gym/shared/", "/v1/gym/shared-logs/"};

// A path is caller-supplied and unbounded, and this line is teed to Sentry as an event body.
constexpr std::size_t kMaxLoggedField = 1024;
constexpr std::string_view kTruncated = "~truncated";
}

Severity severityForStatus(int status) {
  if (status >= 500) return Severity::error;
  if (status >= 400) return Severity::warn;
  return Severity::info;
}

std::string tookMs(long long micros) {
  if (micros < 0) return "?";
  return std::to_string(micros / 1000) + "." + std::to_string((micros % 1000) / 100);
}

std::string loggableField(const std::string& value) {
  std::string safe;
  safe.reserve(std::min(value.size(), kMaxLoggedField));
  for (const unsigned char byte : value) {
    // Measured on the ENCODED length, because a field of control bytes triples on the way through.
    if (safe.size() >= kMaxLoggedField) {
      safe.append(kTruncated);
      break;
    }
    if (byte >= 0x20 && byte != 0x7f) {
      safe.push_back(static_cast<char>(byte));
      continue;
    }
    safe.push_back('%');
    safe.push_back(kHexDigits[byte >> 4]);
    safe.push_back(kHexDigits[byte & 0x0f]);
  }
  return safe;
}

std::string redactedPath(const std::string& path) {
  const std::string safe = path.substr(0, path.find_first_of("?#"));
  std::string folded = safe;
  std::transform(folded.begin(), folded.end(), folded.begin(),
                 [](unsigned char byte) { return static_cast<char>(std::tolower(byte)); });
  for (const std::string_view prefix : kSecretSegmentAfter) {
    if (folded.rfind(prefix, 0) != 0 || safe.size() == prefix.size()) continue;
    return safe.substr(0, prefix.size()) + "{token}";
  }
  return safe;
}

std::string privacySafeLogSource(const std::string& source) {
  const auto begin = source.find_last_of("/\\");
  const std::string name = source.substr(begin == std::string::npos ? 0 : begin + 1);
  const auto colon = name.rfind(':');
  if (colon == std::string::npos || colon == 0 || colon > 96 || name.size() - colon > 11 || colon + 1 == name.size()) return {};
  const bool filename = std::all_of(name.begin(), name.begin() + colon,
      [](unsigned char byte) { return std::isalnum(byte) || byte == '_' || byte == '-' || byte == '.'; });
  const bool line = std::all_of(name.begin() + colon + 1, name.end(),
      [](unsigned char byte) { return std::isdigit(byte); });
  return filename && line ? name : std::string{};
}

std::string privacySafeLogBody(const std::string& body, const std::string& source) {
  if (body.empty()) return {};
  static const std::set<std::string> ownedSources{
      "WriteObservation.cpp", "WriteRoutes.cpp", "AccessLog.cpp", "VendorCall.cpp", "SentryClient.cpp",
      "main.cpp", "mcp_http_main.cpp", "RoomRegistry.cpp", "TreeRoom.cpp", "HttpEmbedder.cpp",
      "OpenAiTranscriber.cpp", "ReminderSweep.cpp", "Collab.cpp", "SyncSocket.cpp", "AuthService.cpp",
      "RetentionSweep.h", "ResendWebhookApi.cpp", "PgSweepMutex.h", "EventsApi.cpp", "FeedbackApi.cpp",
      "OAuthApi.cpp", "BillingApi.cpp", "ForkSignup.cpp", "EchoSweep.cpp", "NudgeSweep.cpp",
      "EchoDerivations.cpp", "AppleOAuthClient.cpp", "AnthropicStream.cpp", "AnthropicClient.cpp",
      "AnthropicAsk.cpp", "AnthropicAgent.cpp", "PgAiUsageRepository.cpp"};
  const std::string safeSource = privacySafeLogSource(source);
  const auto colon = safeSource.rfind(':');
  const std::string filename = safeSource.substr(0, colon);
  if (!ownedSources.count(filename)) return "framework diagnostic suppressed";
  return body;
}

}
