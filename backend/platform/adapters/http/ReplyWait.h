#pragma once

#include <chrono>

namespace wm {

// How long each hop in front of a handler waits for its reply. In production Cloudflare answers 524 itself when the
// origin has not answered within its Proxy Read Timeout, 125 s unless an Enterprise zone changes it. windmill_server
// drops a connection that has read and written nothing for kIdleConnectionLimit, a request's wait for its reply
// included, and a reply written after that is lost with the connection; on a local run it is the only limit there is.
// A vendor call that a reply waits on has to end inside both, with time left for the route's own reads before it and
// its settle after: kVendorReplyWait.
constexpr std::chrono::seconds kEdgeReplyLimit{125};
constexpr std::chrono::seconds kIdleConnectionLimit{60};
constexpr std::chrono::seconds kVendorReplyWait{50};

static_assert(kIdleConnectionLimit < kEdgeReplyLimit, "the server ends a wait before the edge does");
static_assert(kVendorReplyWait + std::chrono::seconds{10} <= kIdleConnectionLimit,
              "a vendor call a reply waits on leaves the route time to answer");

}
