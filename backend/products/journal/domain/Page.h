#pragma once

#include "platform/domain/Ids.h"

#include <compare>
#include <cstddef>
#include <cstdint>
#include <optional>
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

// A point on either 0…10 scale — canon `docs/design/journal/scales.md`. Both scales share this
// one shape. `std::optional<Score>` with no value is the unanswered state; 0 is an answer.
class Score {
public:
  explicit Score(int value);                     // throws InvalidPage outside 0…10
  static std::optional<Score> from(int value);   // outside 0…10 narrows to unset, never throws

  int value() const { return value_; }

  bool operator==(const Score&) const = default;
  auto operator<=>(const Score&) const = default;

private:
  int value_;
};

// How the words arrived; spoken pages carry no audio, it is discarded after transcription.
enum class Source { typed, spoken };

inline std::string toString(Source source) { return source == Source::spoken ? "spoken" : "typed"; }

Source parseSource(std::string_view text);   // anything but "spoken" reads as typed

// One page per user per local day. `stamp` is the HLC the writing device minted and the sole
// convergence key: two devices editing a day converge on the greater stamp, last-writer-wins.
// `updatedAtMs` is server time, for display only.
struct Page {
  UserId user;
  LocalDate day;
  std::string body;
  std::optional<Score> mood;
  std::optional<Score> energy;
  Source source;
  Hlc stamp;
  std::uint64_t updatedAtMs;

  Page(UserId user, LocalDate day, std::string body, std::optional<Score> mood,
       std::optional<Score> energy, Source source, Hlc stamp, std::uint64_t updatedAtMs);
  Page(UserId user, LocalDate day);

  bool operator==(const Page&) const = default;
};

}
