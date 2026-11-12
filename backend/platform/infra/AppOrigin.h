#pragma once

#include <cstdlib>
#include <string>

namespace wm {

// The app's public origin, which every link a person opens starts with: WINDMILL_APP_URL, or the local web app.
// Each composition root reads it here, so the server and both MCP transports hand out the same addresses.
inline std::string appOriginFromEnvironment() {
  const char* configured = std::getenv("WINDMILL_APP_URL");
  return configured ? configured : "http://localhost:5183";
}

}
