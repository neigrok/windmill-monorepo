#include "platform/domain/sync/Identity.h"

#include <cctype>
#include <charconv>
#include <stdexcept>
#include <utility>

namespace wm::sync {

std::string deriveId(std::string_view label, std::string_view fallback, const std::set<std::string>& taken) {
  constexpr std::size_t kBaseLimit = 40;
  std::string base;
  for (const char c : label) {
    if (base.size() == kBaseLimit) break;
    const auto byte = static_cast<unsigned char>(c);
    if (byte < 0x80 && std::isalnum(byte)) base.push_back(static_cast<char>(std::tolower(byte)));
    else if (!base.empty() && base.back() != '-') base.push_back('-');
  }
  while (!base.empty() && base.back() == '-') base.pop_back();
  if (base.empty()) base = fallback;

  std::string id = base;
  for (int suffix = 2; taken.contains(id); ++suffix) id = base + "-" + std::to_string(suffix);
  return id;
}

SeededId SeededId::of(const TypeDef& type, std::string seed, std::int64_t n) {
  if (!type.seeded) throw std::invalid_argument(type.name + " does not seed ids");
  if (seed.size() > static_cast<std::size_t>(type.seeded->seedMax) || !type.idPattern || !type.idPattern->matches(seed))
    throw std::invalid_argument("a seed is an id of the type of at most seedMax characters");
  if (n < 1 || n > type.seeded->ordinalMax) throw std::invalid_argument("an ordinal lies in 1..ordinalMax");
  SeededId id{std::move(seed), n};
  if (!type.idPattern->matches(id.text())) throw std::invalid_argument("a seeded id matches the type's pattern");
  return id;
}

std::optional<SeededId> SeededId::parse(std::string_view id) {
  const std::size_t cut = id.rfind('-');
  if (cut == std::string_view::npos || cut == 0) return std::nullopt;
  const std::string_view ordinal = id.substr(cut + 1);
  if (ordinal.empty() || ordinal.front() == '0') return std::nullopt;
  std::int64_t n = 0;
  const auto [end, error] = std::from_chars(ordinal.data(), ordinal.data() + ordinal.size(), n);
  if (error != std::errc{} || end != ordinal.data() + ordinal.size()) return std::nullopt;
  return SeededId{std::string(id.substr(0, cut)), n};
}

}
