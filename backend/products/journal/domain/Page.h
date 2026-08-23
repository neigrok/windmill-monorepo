#pragma once

#include "platform/domain/Ids.h"

#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <string_view>

namespace wm {

// A malformed page — thrown at the boundary where a Page is constructed from untrusted input.
struct InvalidPage : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// A page longer than any day of writing. Its own kind so the boundary can answer "too long" rather
// than "could not read that page".
struct PageTooLarge : InvalidPage {
  using InvalidPage::InvalidPage;
};

// What one day may weigh. Every superseding write trails the body it replaced into
// journal_page_revision, so an uncapped page is an uncapped row TRAIL. 128 KB is about
// twenty-five thousand words on a single day — a fuse, not a limit anyone is meant to meet.
constexpr std::size_t kMaxPageBytes = 128 * 1024;

// The floor of the addressable calendar: year 0000 is not a date at all and Postgres has no such
// year. It cannot be raised while the web client sends "0001-01-01" as its open-ended echo window
// (web/src/products/journal/echoes/useEchoes.js) — move that sentinel first, then this.
constexpr int kFirstJournalYear = 1;

// A calendar day in the writer's own zone, "YYYY-MM-DD". Not an instant: the page for a day is the
// same page whether it is opened at 23:04 or 00:10, and the zone is always the device's. The ISO
// shape sorts lexicographically into true date order, so the default spaceship is canvas order.
class LocalDate {
public:
  explicit LocalDate(std::string iso);           // throws InvalidPage unless this is a day that happened
  const std::string& iso() const { return iso_; }

  bool operator==(const LocalDate&) const = default;
  auto operator<=>(const LocalDate&) const = default;

private:
  std::string iso_;
};

// Mood is one hue in five steps; none is the unset state, drawn but never counted. Energy is the
// same shape in three steps.
enum class Mood { none = 0, m1, m2, m3, m4, m5 };
enum class Energy { none = 0, e1, e2, e3 };

// How the words arrived. spoken pages carry no audio — it is discarded after transcription, and
// source is the only trace that the page was talked, not typed.
enum class Source { typed, spoken };

inline int toInt(Mood mood) { return static_cast<int>(mood); }
inline int toInt(Energy energy) { return static_cast<int>(energy); }
inline std::string toString(Source source) { return source == Source::spoken ? "spoken" : "typed"; }

Mood moodFromInt(int value);           // out of 0..5 clamps to none — a bad value can only narrow, never lie
Energy energyFromInt(int value);       // out of 0..3 clamps to none
Source parseSource(std::string_view text);   // anything but "spoken" reads as typed

// The unit of the whole product: one page per user per local day. stamp is the HLC the writing
// device minted (platform/domain/Ids.h) and the sole convergence key — two devices editing the same
// day converge on the greater stamp, last-writer-wins, with no CRDT text. updatedAtMs is server
// time, stamped on store, for display only.
struct Page {
  UserId user;
  LocalDate day;
  std::string body;
  Mood mood;
  Energy energy;
  Source source;
  Hlc stamp;
  std::uint64_t updatedAtMs;

  Page(UserId user, LocalDate day, std::string body, Mood mood, Energy energy, Source source,
       Hlc stamp, std::uint64_t updatedAtMs);
  // A fresh page for a day: empty body, no mood/energy, typed, unset stamp — the shape the write
  // boundary fills in field by field.
  Page(UserId user, LocalDate day);

  bool operator==(const Page&) const = default;
};

}
