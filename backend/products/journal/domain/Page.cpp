#include "products/journal/domain/Page.h"

#include <utility>

namespace wm {

Score::Score(int value) : value_(value) {
  if (value < 0 || value > 10)
    throw InvalidPage("a score runs 0..10: " + std::to_string(value));
}

std::optional<Score> Score::from(int value) {
  if (value < 0 || value > 10) return std::nullopt;
  return Score{value};
}

Page::Page(UserId user, LocalDate day, std::string body, std::optional<Score> mood,
           std::optional<Score> energy, Source source, Hlc stamp, std::uint64_t updatedAtMs)
    : user(std::move(user)), day(std::move(day)), body(std::move(body)), mood(mood), energy(energy),
      source(source), stamp(std::move(stamp)), updatedAtMs(updatedAtMs) {}

Page::Page(UserId user, LocalDate day)
    : user(std::move(user)), day(std::move(day)), body(), mood(std::nullopt), energy(std::nullopt),
      source(Source::typed), stamp(), updatedAtMs(0) {}

LocalDate::LocalDate(std::string iso) {
  auto digit = [](char c) { return c >= '0' && c <= '9'; };
  bool shaped = iso.size() == 10 && iso[4] == '-' && iso[7] == '-' &&
                digit(iso[0]) && digit(iso[1]) && digit(iso[2]) && digit(iso[3]) &&
                digit(iso[5]) && digit(iso[6]) && digit(iso[8]) && digit(iso[9]);
  if (!shaped) throw InvalidPage("date must be YYYY-MM-DD: " + iso);

  int year = (iso[0] - '0') * 1000 + (iso[1] - '0') * 100 + (iso[2] - '0') * 10 + (iso[3] - '0');
  if (year < kFirstJournalYear) throw InvalidPage("year out of range: " + iso);

  int month = (iso[5] - '0') * 10 + (iso[6] - '0');
  if (month < 1 || month > 12) throw InvalidPage("month out of range: " + iso);

  const bool leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
  constexpr int lengths[13] = {0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  const int daysInMonth = month == 2 && leap ? 29 : lengths[month];

  int day = (iso[8] - '0') * 10 + (iso[9] - '0');
  if (day < 1 || day > daysInMonth) throw InvalidPage("day out of range: " + iso);

  iso_ = std::move(iso);
}

Source parseSource(std::string_view text) {
  return text == "spoken" ? Source::spoken : Source::typed;
}

}
