#include "products/journal/domain/Page.h"

#include <utility>

namespace wm {

Page::Page(UserId user, LocalDate day, std::string body, Mood mood, Energy energy, Source source,
           Hlc stamp, std::uint64_t updatedAtMs)
    : user(std::move(user)), day(std::move(day)), body(std::move(body)), mood(mood), energy(energy),
      source(source), stamp(std::move(stamp)), updatedAtMs(updatedAtMs) {}

Page::Page(UserId user, LocalDate day)
    : user(std::move(user)), day(std::move(day)), body(), mood(Mood::none), energy(Energy::none),
      source(Source::typed), stamp(), updatedAtMs(0) {}

// Strict shape check only — "YYYY-MM-DD" with an in-range month and day. It is deliberately not a
// calendar: it never asks a time library what today is, and a valid-looking impossible day like a
// 31st of February passes, because the writer's device owns the calendar and the boundary owns only
// the shape. What it refuses is a value that could not have been a real date at all.
LocalDate::LocalDate(std::string iso) {
  auto digit = [](char c) { return c >= '0' && c <= '9'; };
  bool shaped = iso.size() == 10 && iso[4] == '-' && iso[7] == '-' &&
                digit(iso[0]) && digit(iso[1]) && digit(iso[2]) && digit(iso[3]) &&
                digit(iso[5]) && digit(iso[6]) && digit(iso[8]) && digit(iso[9]);
  if (!shaped) throw InvalidPage("date must be YYYY-MM-DD: " + iso);

  int month = (iso[5] - '0') * 10 + (iso[6] - '0');
  if (month < 1 || month > 12) throw InvalidPage("month out of range: " + iso);

  int day = (iso[8] - '0') * 10 + (iso[9] - '0');
  if (day < 1 || day > 31) throw InvalidPage("day out of range: " + iso);

  iso_ = std::move(iso);
}

Mood moodFromInt(int value) {
  switch (value) {
    case 1: return Mood::m1;
    case 2: return Mood::m2;
    case 3: return Mood::m3;
    case 4: return Mood::m4;
    case 5: return Mood::m5;
  }
  return Mood::none;
}

Energy energyFromInt(int value) {
  switch (value) {
    case 1: return Energy::e1;
    case 2: return Energy::e2;
    case 3: return Energy::e3;
  }
  return Energy::none;
}

Source parseSource(std::string_view text) {
  return text == "spoken" ? Source::spoken : Source::typed;
}

}
