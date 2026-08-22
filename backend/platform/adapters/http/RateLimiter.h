#pragma once

#include <drogon/HttpRequest.h>

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <mutex>
#include <string>
#include <unordered_map>

namespace wm {

// A token-bucket limiter keyed by an opaque string (a client IP). Thread-safe, and
// self-bounding: once the table is large it sweeps idle keys, so a flood of distinct keys
// cannot grow it without limit.
class RateLimiter {
public:
  RateLimiter(double ratePerSecond, double burst) : rate_(ratePerSecond), burst_(burst) {}

  bool allow(const std::string& key) {
    const TimePoint now = std::chrono::steady_clock::now();
    std::lock_guard<std::mutex> lock(mutex_);
    if (buckets_.size() > kMaxKeys) sweep(now);
    Bucket& bucket = buckets_[key];
    if (bucket.seen == TimePoint{}) {
      bucket.tokens = burst_;
    } else {
      const double elapsed = std::chrono::duration<double>(now - bucket.seen).count();
      bucket.tokens = std::min(burst_, bucket.tokens + elapsed * rate_);
    }
    bucket.seen = now;
    if (bucket.tokens < 1.0) return false;
    bucket.tokens -= 1.0;
    return true;
  }

private:
  using TimePoint = std::chrono::steady_clock::time_point;
  struct Bucket {
    double tokens = 0;
    TimePoint seen{};
  };
  void sweep(TimePoint now) {
    for (auto it = buckets_.begin(); it != buckets_.end();) {
      if (std::chrono::duration<double>(now - it->second.seen).count() > kIdleSeconds)
        it = buckets_.erase(it);
      else
        ++it;
    }
  }
  static constexpr std::size_t kMaxKeys = 100000;
  static constexpr double kIdleSeconds = 300.0;
  const double rate_;
  const double burst_;
  std::mutex mutex_;
  std::unordered_map<std::string, Bucket> buckets_;
};

// The real client IP. Behind Cloudflare that is CF-Connecting-IP: the edge sets it to the
// original visitor and overwrites any client-sent copy, so we trust it first. That trust is
// borrowed, not owned — it holds only while the origin refuses traffic that did not come through
// Cloudflare, and it is enforced in exactly two places: the `(cloudflare_only)` gate in
// deploy/Caddyfile (imported FIRST in every site block — see the warning there, it was dead code
// until 2026-08-22 and this line said "should" while nothing did) and the CF-only firewall rules
// in deploy/README.md §1. Break either one and every per-IP ceiling below becomes advisory.
// Absent that header, fall back to the LAST X-Forwarded-For entry, the peer the proxy actually
// observed, so a client-prepended forgery sits to its left and is ignored. Empty means no proxy
// header at all — internal traffic (health checks, sibling services on the compose network), left
// unlimited, which is sound for exactly as long as the gate above keeps the outside from looking
// internal.
inline std::string clientIp(const drogon::HttpRequestPtr& request) {
  const std::string& connecting = request->getHeader("cf-connecting-ip");
  if (!connecting.empty()) return connecting;
  const std::string& forwarded = request->getHeader("x-forwarded-for");
  if (forwarded.empty()) return "";
  const std::size_t last = forwarded.find_last_of(',');
  std::string ip = last == std::string::npos ? forwarded : forwarded.substr(last + 1);
  const std::size_t begin = ip.find_first_not_of(" \t");
  const std::size_t end = ip.find_last_not_of(" \t");
  if (begin == std::string::npos) return "";
  return ip.substr(begin, end - begin + 1);
}

}
