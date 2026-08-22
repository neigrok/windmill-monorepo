#pragma once

#include "platform/domain/Ids.h"

#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <string_view>

namespace wm {

// A malformed page — a bad date, an out-of-range field. Thrown at the boundary where a Page is
// constructed from untrusted input, so a storage typo or a bad request can never become a row.
struct InvalidPage : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// A page longer than any day of writing. Its own kind because the boundary answers it differently —
// "too long" is a fact the writer can act on, and reading it back as "could not read that page"
// would send somebody hunting for a typo in prose that is fine.
struct PageTooLarge : InvalidPage {
  using InvalidPage::InvalidPage;
};

// WHAT ONE DAY MAY WEIGH, and it is a storage rule before it is a writing one. Every superseding
// write trails the body it replaced into journal_page_revision, so an uncapped page is an uncapped
// row TRAIL — the shared Postgres that serves all three products, filled by one account at the
// global 8 MB body cap, one PUT at a time.
//
// 128 KB is about twenty-five thousand words on a single day: past any evening anybody writes,
// past a long pasted letter, and still two orders of magnitude under what the trail could take.
// The client sends far less (web/src/products/journal/pageStore.js sends the textarea), so this is
// a fuse and not a limit anyone is meant to meet.
constexpr std::size_t kMaxPageBytes = 128 * 1024;

// The floor of the addressable calendar, and it is the CALENDAR's floor rather than a product
// opinion: year 0000 is not a date at all — Postgres has no such year, so it used to arrive as a
// pqxx exception and a 500. A tighter, more human floor (say 1900) would be defensible, and is not
// taken here because the open-ended echo window the web client sends is literally "0001-01-01"
// (web/src/products/journal/echoes/useEchoes.js) — a floor above it would refuse every reader's
// echo list. Move the sentinel first, then this.
constexpr int kFirstJournalYear = 1;

// A calendar day in the writer's own zone, "YYYY-MM-DD". Not an instant: the page for a day is the
// same page whether it is opened at 23:04 or 00:10, and the zone is always the device's, never the
// server's UTC. The ISO shape sorts lexicographically into true date order, so the default
// spaceship over the stored text is exactly the canvas order (oldest first).
class LocalDate {
public:
  explicit LocalDate(std::string iso);           // throws InvalidPage unless this is a day that happened
  const std::string& iso() const { return iso_; }

  bool operator==(const LocalDate&) const = default;
  auto operator<=>(const LocalDate&) const = default;

private:
  std::string iso_;
};

// Mood is one hue in five steps — a scale, not five competing colours (canon §10). none is the
// unset state, drawn but never counted. Energy is the same shape in three steps.
enum class Mood { none = 0, m1, m2, m3, m4, m5 };
enum class Energy { none = 0, e1, e2, e3 };

// How the words arrived. spoken pages carry no audio — transcription happens off the page and the
// audio is discarded; source is the only trace that it was talked, not typed (canon §06).
enum class Source { typed, spoken };

inline int toInt(Mood mood) { return static_cast<int>(mood); }
inline int toInt(Energy energy) { return static_cast<int>(energy); }
inline std::string toString(Source source) { return source == Source::spoken ? "spoken" : "typed"; }

Mood moodFromInt(int value);           // out of 0..5 clamps to none — a bad value can only narrow, never lie
Energy energyFromInt(int value);       // out of 0..3 clamps to none
Source parseSource(std::string_view text);   // anything but "spoken" reads as typed

// The unit of the whole product: one page per user per local day. stamp is the HLC the writing
// device minted (platform/domain/Ids.h); it is the sole convergence key — two devices editing the
// same day converge on the greater stamp, last-writer-wins, with no CRDT text and no room.
// updatedAtMs is server time, stamped on store, for display only. It carries real constructors
// (never aggregate init) so an optional<Page> returned across the port boundary is always a
// fully-formed object — the invariants that matter (a valid date, an in-range mood) are guarded
// where the value types are built, not here.
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
