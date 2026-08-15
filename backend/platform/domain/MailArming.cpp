#include "platform/domain/MailArming.h"

#include <algorithm>
#include <cctype>

namespace wm {

MailArming::MailArming(bool enabled, const std::string& allowlistCsv) : enabled(enabled) {
  std::size_t start = 0;
  while (start <= allowlistCsv.size()) {
    const std::size_t comma = allowlistCsv.find(',', start);
    std::string id = allowlistCsv.substr(start, comma - start);
    // A uuid pasted from a console arrives with stray spacing and any casing; the column it is
    // compared against is always lowercase, so meet it there. Trimming alone makes an uppercase id
    // on the list match nobody, silently, in the one direction an operator cannot see: they name an
    // account, believe it armed, and it never hears a thing.
    id.erase(0, id.find_first_not_of(" \t\r\n"));
    const std::size_t end = id.find_last_not_of(" \t\r\n");
    if (end != std::string::npos) id.resize(end + 1);
    std::transform(id.begin(), id.end(), id.begin(), [](unsigned char c) { return std::tolower(c); });
    if (!id.empty()) allowlist.insert(id);
    if (comma == std::string::npos) break;
    start = comma + 1;
  }
}

bool MailArming::allows(const UserId& user) const {
  if (!enabled) return false;
  std::string id = user.str();
  std::transform(id.begin(), id.end(), id.begin(), [](unsigned char c) { return std::tolower(c); });
  return allowlist.count(id) > 0;
}

}
