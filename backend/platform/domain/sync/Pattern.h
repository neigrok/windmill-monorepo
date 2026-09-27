#pragma once

#include <memory>
#include <string>
#include <string_view>

namespace wm::sync {

// §2.4's portable pattern: printable ASCII, `^`, a body of literals, escaped syntax characters, bracket classes of
// literals and ascending ranges, groups (the only place a `|` may stand) and greedy quantifiers counting at most
// 65 535, then `$`. Every atom matches one ASCII byte, and a value matches only as a whole.
//
// The pattern is matched by its own reading of the body, never by a regex library: std::regex over libstdc++
// refuses a count whose unrolled automaton passes its state limit, and recurses once per byte of the value. A
// match takes the body's derivative byte by byte (Brzozowski), keeping each count a number, so every portable
// pattern compiles and a match uses no stack that the value's length decides.
class Pattern {
public:
  // Throws std::invalid_argument for a source outside the portable subset.
  explicit Pattern(std::string source);

  static bool isPortable(std::string_view source);

  bool matches(std::string_view value) const;
  const std::string& source() const { return source_; }

  // The body read into its atoms, shared by every copy of the pattern.
  struct Body;

private:
  std::string source_;
  std::shared_ptr<const Body> body_;
};

}
