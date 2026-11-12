#pragma once

#include <string>

namespace wm {

// An origin every link is built on by appending a path: the configured value with any '/' it ends with dropped, so
// the path never doubles one.
inline std::string normalizedOrigin(std::string configured) {
  while (!configured.empty() && configured.back() == '/') configured.pop_back();
  return configured;
}

}
