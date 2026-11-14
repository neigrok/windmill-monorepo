#pragma once

#include <chrono>

namespace wm {

constexpr std::chrono::seconds kEdgeReplyLimit{125};       // Cloudflare's Proxy Read Timeout, then it answers 524
constexpr std::chrono::seconds kIdleConnectionLimit{60};    // windmill_server drops a silent connection, a waiting reply's included
constexpr std::chrono::seconds kVendorReplyWait{50};        // a vendor call a reply waits on ends inside both, with room to answer

static_assert(kIdleConnectionLimit < kEdgeReplyLimit, "the server ends a wait before the edge does");
static_assert(kVendorReplyWait + std::chrono::seconds{10} <= kIdleConnectionLimit,
              "a vendor call a reply waits on leaves the route time to answer");

}
