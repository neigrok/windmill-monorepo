#pragma once

#include <string>
#include <vector>

namespace wm {

// An MCP resource: a document a client may read on connect, addressed by uri. It costs no tool
// slot, which is why the things agents reliably get backwards live here rather than in a tool
// description no one re-reads. Everything a resource claims must be true of the shipped server —
// a quickstart that lies is worse than no quickstart — so each line of it is checked against the
// tool catalog it describes.
struct McpResource {
  std::string uri;
  std::string name;
  std::string title;
  std::string description;
  std::string mimeType;
  std::string text;
};

// Everything this server publishes under `resources/list`; today, the quickstart alone.
const std::vector<McpResource>& resourceCatalog();

}
