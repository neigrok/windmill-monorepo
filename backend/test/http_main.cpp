#include "platform/adapters/http/JsonReply.h"
#include "test/testing.h"

#include <drogon/HttpAppFramework.h>

// The main for the two binaries that link Drogon. Drogon fixes its JSON writer on the first body it
// serialises, so the rule the servers set before taking traffic is set here before any case runs —
// a byte a test pins on a reply's body is the byte on the wire.
int main() {
  wm::configureJsonReplies(drogon::app());
  return ::testing::run();
}
