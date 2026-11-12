#pragma once

#include "platform/domain/Origin.h"

#include <cstdlib>
#include <string>

namespace wm {

// The app's public origin, which every link a person opens starts with: WINDMILL_APP_URL, or the local web app, with
// any '/' it ends with dropped. Each composition root reads it here, so the server and both MCP transports hand out
// the same addresses, and no link built on it doubles a '/'.
inline std::string appOriginFromEnvironment() {
  const char* configured = std::getenv("WINDMILL_APP_URL");
  return normalizedOrigin(configured ? configured : "http://localhost:5183");
}

}
