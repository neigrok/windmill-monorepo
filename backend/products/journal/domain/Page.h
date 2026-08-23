#pragma once

#include "platform/domain/Ids.h"

#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <string_view>

namespace wm {

struct InvalidPage : std::runtime_error {
  using std::runtime_error::runtime_error;
};

struct PageTooLarge : InvalidPage {
  using InvalidPage::InvalidPage;
};

constexpr std::size_t kMaxPageBytes = 128 * 1024;

// The floor of the addressable calendar. Cannot be raised while the web client sends "0001-01-01"
// as its open-ended echo window.
constexpr int kFirstJournalYear = 1;

// A calendar day in the writer's own zone, "YYYY-MM-DD" — not an instant. The ISO shape sorts
// lexicographically into date order.
class LocalDate {
public:
  explicit LocalDate(std::string iso);           // throws InvalidPage unless this is a day that happened
  const std::string& iso() const { return iso_; }

  bool operator==(const LocalDate&) const = default;
  auto operator<=>(const LocalDate&) const = default;

private:
  std::string iso_;
};

// `none` is the unset state, never counted.
enum class Mood { none = 0, m1, m2, m3, m4, m5 };
enum class Energy { none = 0, e1, e2, e3 };

// How the words arrived; spoken pages carry no audio, it is discarded after transcription.
enum class Source { typed, spoken };

inline int toInt(Mood mood) { return static_cast<int>(mood); }
inline int toInt(Energy energy) { return static_cast<int>(energy); }
inline std::string toString(Source source) { return source == Source::spoken ? "spoken" : "typed"; }

Mood moodFromInt(int value);           // out of 0..5 clamps to none
Energy energyFromInt(int value);       // out of 0..3 clamps to none
Source parseSource(std::string_view text);   // anything but "spoken" reads as typed

// One page per user per local day. `stamp` is the HLC the writing device minted and the sole
// convergence key: two devices editing a day converge on the greater stamp, last-writer-wins.
// `updatedAtMs` is server time, for display only.
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
  Page(UserId user, LocalDate day);

  bool operator==(const Page&) const = default;
};

}
