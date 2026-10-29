#include "platform/domain/Nfc.h"

#include "third_party/utf8proc/utf8proc.h"

#include <cstdlib>
#include <memory>
#include <stdexcept>

namespace wm {

std::string nfc(std::string_view text) {
  utf8proc_uint8_t* composed = nullptr;
  const utf8proc_ssize_t length =
      utf8proc_map(reinterpret_cast<const utf8proc_uint8_t*>(text.data()), static_cast<utf8proc_ssize_t>(text.size()),
                   &composed, static_cast<utf8proc_option_t>(UTF8PROC_STABLE | UTF8PROC_COMPOSE));
  const std::unique_ptr<utf8proc_uint8_t, decltype(&std::free)> owned(composed, &std::free);
  if (length == UTF8PROC_ERROR_INVALIDUTF8) return std::string(text);
  if (length < 0) throw std::runtime_error(utf8proc_errmsg(length));
  return std::string(reinterpret_cast<const char*>(composed), static_cast<std::size_t>(length));
}

}
