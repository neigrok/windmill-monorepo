#include "platform/adapters/http/JsonReply.h"
#include "test/DrogonLoopback.h"
#include "test/testing.h"

#include <curl/curl.h>
#include <drogon/HttpAppFramework.h>

// The main for binaries that link Drogon. Drogon fixes its JSON writer on the first body it
// serialises, so the rule the servers set before taking traffic is set here before any case runs —
// a byte a test pins on a reply's body is the byte on the wire.
int main() {
  // libcurl's process-wide state, set up once before any case starts a transfer, as the server does.
  if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) return 1;
  wm::configureJsonReplies(drogon::app());
  const int result = ::testing::run();
  wm::test::DrogonLoopback::stopExisting();
  return result;
}
