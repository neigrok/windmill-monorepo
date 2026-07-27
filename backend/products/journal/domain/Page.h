#pragma once

#include "platform/domain/Ids.h"

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

// A calendar day in the writer's own zone, "YYYY-MM-DD". Not an instant: the page for a day is the
// same page whether it is opened at 23:04 or 00:10, and the zone is always the device's, never the
// server's UTC. The ISO shape sorts lexicographically into true date order, so the default
// spaceship over the stored text is exactly the canvas order (oldest first).
class LocalDate {
public:
  explicit LocalDate(std::string iso);           // throws InvalidPage on a shape other than YYYY-MM-DD
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
