#include "products/journal/domain/Passage.h"

#include <algorithm>
#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

namespace wm {

namespace {

// A half-open byte range into the body. A cut lands either on ASCII or on a multi-byte dash or
// ellipsis stepped over whole, so a boundary is never inside a character.
struct Span {
  int lo = 0;
  int hi = 0;
};

// A run of atoms that will not be split further; `maxAtoms` is counted in `atoms`.
struct Unit {
  Span span;
  int atoms = 0;
};

bool isBlank(char c) {
  return c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\v' || c == '\f';
}

Span trimmed(const std::string& body, Span span) {
  while (span.lo < span.hi && isBlank(body[span.lo])) ++span.lo;
  while (span.hi > span.lo && isBlank(body[span.hi - 1])) --span.hi;
  return span;
}

// Whitespace-separated runs, so "- called mum" counts three.
int wordCount(const std::string& body, Span span) {
  int words = 0;
  int at = span.lo;
  while (at < span.hi) {
    while (at < span.hi && isBlank(body[at])) ++at;
    if (at == span.hi) break;
    ++words;
    while (at < span.hi && !isBlank(body[at])) ++at;
  }
  return words;
}

std::vector<Span> linesOf(const std::string& body) {
  std::vector<Span> lines;
  const int size = static_cast<int>(body.size());
  int start = 0;
  while (start <= size) {
    int end = start;
    while (end < size && body[end] != '\n') ++end;
    const Span line = trimmed(body, {start, end});
    if (line.lo < line.hi) lines.push_back(line);
    start = end + 1;
  }
  return lines;
}

// A closing quote or bracket belongs to the sentence it closes; curly forms are three bytes and are
// stepped over whole.
int pastClosers(const std::string& body, Span line, int at) {
  while (at < line.hi) {
    const char c = body[at];
    if (c == '"' || c == '\'' || c == ')' || c == ']' || c == '}') {
      ++at;
      continue;
    }
    const bool curly = line.hi - at >= 3 && (body.compare(at, 3, "\xe2\x80\x9d") == 0 ||   // ”
                                             body.compare(at, 3, "\xe2\x80\x99") == 0);    // ’
    if (!curly) return at;
    at += 3;
  }
  return at;
}

// Does the full stop at `dot` end a word that carries one mid-sentence?
bool closesAbbreviation(const std::string& body, Span line, int dot) {
  static constexpr std::string_view known[] = {"mr", "mrs", "ms",  "dr",  "prof", "st",
                                               "jr", "sr",  "vs",  "etc", "e.g",  "i.e"};
  int start = dot;
  while (start > line.lo && !isBlank(body[start - 1])) --start;
  std::string word = body.substr(start, dot - start);
  for (char& c : word) {
    if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
  }
  for (const std::string_view candidate : known) {
    if (word == candidate) return true;
  }
  return false;
}

// A sentence terminator at `at`: `.`, `!`, `?`, or the three-byte `…` the writer actually types.
// Returns its byte width, or 0.
int terminatorAt(const std::string& body, Span line, int at) {
  const char c = body[at];
  if (c == '.' || c == '!' || c == '?') return 1;
  if (line.hi - at >= 3 && body.compare(at, 3, "\xe2\x80\xa6") == 0) return 3;   // …
  return 0;
}

// A marker that OPENS an atom: whitespace, then one of `+ - – — •`, then whitespace or a word.
// Returns the marker's byte width, or 0.
//
// Two habits, one rule. A mid-line `+` or `-` is a list the writer did not put on its own line, and
// four lines in twenty-six of the one real corpus are written that way — "+я буду… + машу…" — so
// without this they are a single atom carrying every item at once. A dash with whitespace around it
// is the joiner Russian uses where English uses a comma.
//
// A diary is not a calculator: "3 - 2" is cut too. That costs a boundary nobody wanted in a place
// nobody writes about, and merging is free, so it is the cheap side of the trade. A digit right
// after the marker is left alone, which keeps "-5 градусов" whole.
int markerAt(const std::string& body, Span line, int at) {
  if (at <= line.lo || !isBlank(body[at - 1])) return 0;

  const char c = body[at];
  int width = (c == '+' || c == '-') ? 1 : 0;
  if (width == 0 && line.hi - at >= 3 &&
      (body.compare(at, 3, "\xe2\x80\x93") == 0 ||     // –
       body.compare(at, 3, "\xe2\x80\x94") == 0 ||     // —
       body.compare(at, 3, "\xe2\x80\xa2") == 0)) {    // •
    width = 3;
  }
  if (width == 0) return 0;

  const int next = at + width;
  if (next >= line.hi) return 0;                                   // a marker with nothing after it
  if (isBlank(body[next])) return width;
  return (body[next] >= '0' && body[next] <= '9') ? 0 : width;
}

// The last resort, and only inside an atom that already ran past `kLongAtomWords`: cut after a
// comma, but only where three words stand on each side of it. A comma-spliced breath carries three
// topics into one embedding and then matches none of them: measured on the owner's own corpus, one
// such line scored 0.354 against the sentence he wrote about one of those topics, where that
// sentence alone scored 0.950. The three-word margin is what keeps "нет," from becoming an atom.
std::vector<Span> commaCuts(const std::string& body, Span atom) {
  static constexpr int kMarginWords = 3;

  std::vector<Span> pieces;
  int start = atom.lo;
  for (int at = atom.lo; at < atom.hi; ++at) {
    if (body[at] != ',') continue;
    const int next = at + 1;
    if (next >= atom.hi || !isBlank(body[next])) continue;         // "1,5" is one number

    const Span left = trimmed(body, {start, next});
    const Span right = trimmed(body, {next, atom.hi});
    if (wordCount(body, left) < kMarginWords) continue;
    if (wordCount(body, right) < kMarginWords) continue;

    pieces.push_back(left);
    start = next;
  }
  const Span tail = trimmed(body, {start, atom.hi});
  if (tail.lo < tail.hi) pieces.push_back(tail);
  return pieces;
}

// One line cut to the floor. At each byte, in this order: a list marker opens an atom BEFORE
// itself; a run of terminators closes one after itself, carrying whatever closes the clause with
// it; and `;` or `:` before whitespace closes one too. Capitalisation is never consulted — this
// writer does not use any. Whatever survives longer than `kLongAtomWords` is cut again at commas.
// A run with no seam anybody wrote: cut it on whitespace every `kMaxUnitWords` words. The pieces are
// not thoughts and do not pretend to be — they are what keeps a page embeddable at all.
std::vector<Span> wordCuts(const std::string& body, Span piece) {
  std::vector<Span> cuts;
  int start = piece.lo;
  int words = 0;
  int at = piece.lo;
  while (at < piece.hi) {
    while (at < piece.hi && isBlank(body[at])) ++at;
    if (at >= piece.hi) break;
    while (at < piece.hi && !isBlank(body[at])) ++at;
    if (++words < kMaxUnitWords) continue;
    cuts.push_back(trimmed(body, {start, at}));
    start = at;
    words = 0;
  }
  const Span tail = trimmed(body, {start, piece.hi});
  if (tail.lo < tail.hi) cuts.push_back(tail);
  return cuts;
}

std::vector<Span> atomsIn(const std::string& body, Span line) {
  std::vector<Span> cuts;
  int start = line.lo;
  int at = line.lo;
  while (at < line.hi) {
    const int marker = markerAt(body, line, at);
    if (marker > 0) {
      const Span before = trimmed(body, {start, at});
      if (before.lo < before.hi) {
        cuts.push_back(before);
        start = at;
      }
      at += marker;
      continue;
    }

    const int terminator = terminatorAt(body, line, at);
    if (terminator > 0) {
      int end = at + terminator;   // "..." and "?!" end one atom, not three
      while (end < line.hi) {
        const int more = terminatorAt(body, line, end);
        if (more == 0) break;
        end += more;
      }
      const int after = pastClosers(body, line, end);
      at = end;

      if (after >= line.hi) break;                                       // the line ends the atom
      if (!isBlank(body[after])) continue;                               // inside a number or a url
      if (body[end - 1] == '.' && closesAbbreviation(body, line, end - 1)) continue;

      cuts.push_back(trimmed(body, {start, after}));
      start = after;
      at = after;
      continue;
    }

    if ((body[at] == ';' || body[at] == ':') && at + 1 < line.hi && isBlank(body[at + 1])) {
      cuts.push_back(trimmed(body, {start, at + 1}));
      start = at + 1;
      at = at + 1;
      continue;
    }
    ++at;
  }
  const Span tail = trimmed(body, {start, line.hi});
  if (tail.lo < tail.hi) cuts.push_back(tail);

  std::vector<Span> atoms;
  for (const Span& cut : cuts) {
    if (wordCount(body, cut) <= kLongAtomWords) {
      atoms.push_back(cut);
      continue;
    }
    for (const Span& piece : commaCuts(body, cut)) {
      // The hard ceiling, and the reason it exists is downstream: `unitsFrom` never splits INSIDE an
      // atom (a boundary the model was never offered has no business in the writer's sentence), so
      // an atom with no punctuation and no commas would be an unsplittable unit of any length — and
      // past the embedder's window the sidecar refuses the batch and the page can never be stored
      // at all. Every other cut here is a seam somebody wrote; this one is arbitrary, which is why
      // it is last and why it only ever runs on a line that offered nothing better.
      if (wordCount(body, piece) <= kMaxUnitWords) {
        atoms.push_back(piece);
        continue;
      }
      for (const Span& word : wordCuts(body, piece)) atoms.push_back(word);
    }
  }
  return atoms;
}

// Fragments merge first and the `maxAtoms` cap applies to what survives, so a merge may overrun it.
std::vector<Span> passagesIn(const std::string& body, Span line, const SegmentRules& rules) {
  std::vector<Unit> units;
  for (const Span& atom : atomsIn(body, line)) {
    if (!units.empty() && wordCount(body, atom) < rules.minWords) {
      units.back().span.hi = atom.hi;
      ++units.back().atoms;
      continue;
    }
    units.push_back({atom, 1});
  }
  // An opening fragment joins the one after instead; with no "after", it stands as its own passage.
  if (units.size() > 1 && wordCount(body, units.front().span) < rules.minWords) {
    units[1].span.lo = units.front().span.lo;
    units[1].atoms += units.front().atoms;
    units.erase(units.begin());
  }

  std::vector<Span> passages;
  for (std::size_t i = 0; i < units.size();) {
    Span span = units[i].span;
    int joined = units[i].atoms;
    ++i;
    while (i < units.size() && joined + units[i].atoms <= rules.maxAtoms) {
      span.hi = units[i].span.hi;
      joined += units[i].atoms;
      ++i;
    }
    passages.push_back(span);
  }
  return passages;
}

}

// Passages are produced one line at a time; nothing downstream of `linesOf` sees across a break.
std::vector<Passage> segment(const std::string& body, const SegmentRules& rules) {
  std::vector<Passage> passages;
  for (const Span& line : linesOf(body)) {
    for (const Span& span : passagesIn(body, line, rules)) {
      passages.push_back(Passage{static_cast<int>(passages.size()), span.lo, span.hi,
                                 body.substr(span.lo, span.hi - span.lo)});
    }
  }
  return passages;
}

int wordsIn(const std::string& text) {
  return wordCount(text, Span{0, static_cast<int>(text.size())});
}

// Whitespace and nothing else: no case folding, no punctuation stripping, no Unicode folding.
std::string normalizedForIdentity(const std::string& text) {
  std::string identity;
  identity.reserve(text.size());
  bool separated = false;   // whitespace seen; spent only once something follows it
  for (const char c : text) {
    if (isBlank(c)) {
      separated = !identity.empty();
      continue;
    }
    if (separated) {
      identity.push_back(' ');
      separated = false;
    }
    identity.push_back(c);
  }
  return identity;
}

namespace {

// Does `unit` sit in `body` starting exactly at `at`, treating any run of whitespace on either side
// as one? Returns the end offset in the body, or -1. The unit is already trimmed by the caller.
int matchAt(const std::string& body, const std::string& unit, int at) {
  const int bodySize = static_cast<int>(body.size());
  const int unitSize = static_cast<int>(unit.size());
  int b = at;
  int u = 0;
  while (u < unitSize) {
    if (isBlank(unit[u])) {
      // A whitespace run must be answered by at least one whitespace byte, however spelled.
      if (b >= bodySize || !isBlank(body[b])) return -1;
      while (b < bodySize && isBlank(body[b])) ++b;
      while (u < unitSize && isBlank(unit[u])) ++u;
      continue;
    }
    if (b >= bodySize || body[b] != unit[u]) return -1;
    ++b;
    ++u;
  }
  return b;
}

// The first place at or after `from` where `unit` sits, or -1.
int findFrom(const std::string& body, const std::string& unit, int from) {
  if (unit.empty()) return -1;
  const int bodySize = static_cast<int>(body.size());
  for (int at = std::max(0, from); at < bodySize; ++at) {
    if (body[at] != unit[0]) continue;
    if (matchAt(body, unit, at) >= 0) return at;
  }
  return -1;
}

}

std::vector<Passage> locateUnits(const std::string& body, const std::vector<std::string>& units) {
  std::vector<Passage> passages;
  int after = 0;
  for (const std::string& raw : units) {
    const Span trimmedUnit = trimmed(raw, {0, static_cast<int>(raw.size())});
    const std::string unit = raw.substr(trimmedUnit.lo, trimmedUnit.hi - trimmedUnit.lo);
    if (unit.empty()) continue;

    int lo = findFrom(body, unit, after);
    // Out of order or overlapping something taken: look once from the top before giving up.
    if (lo < 0) lo = findFrom(body, unit, 0);
    if (lo < 0) continue;

    const int hi = matchAt(body, unit, lo);
    passages.push_back(Passage{static_cast<int>(passages.size()), lo, hi,
                               body.substr(lo, hi - lo)});
    after = hi;
  }
  return passages;
}

std::vector<Passage> atomsOf(const std::string& body) {
  // minWords 0 merges nothing and maxAtoms 1 joins nothing, so `segment` cuts to its floor.
  return segment(body, SegmentRules{0, 1});
}

Grouping unitsFrom(const std::string& body, const std::vector<Passage>& atoms,
                   const std::vector<int>& starts) {
  Grouping grouped;
  if (atoms.empty()) return grouped;

  const int count = static_cast<int>(atoms.size());
  std::vector<int> opens;
  for (const int start : starts) {
    if (start < 1 || start > count) {
      ++grouped.dropped;                       // named an atom that is not on the page
      continue;
    }
    opens.push_back(start);
  }
  std::sort(opens.begin(), opens.end());
  const std::size_t named = opens.size();
  opens.erase(std::unique(opens.begin(), opens.end()), opens.end());
  grouped.dropped += static_cast<int>(named - opens.size());   // the same atom opened twice

  // The first atom opens a unit whether or not anyone said so: text before the first named start
  // belongs to somebody, and dropping it would lose the writer a thought.
  if (opens.empty() || opens.front() != 1) opens.insert(opens.begin(), 1);

  // A unit is a run of atoms, so nothing above bounds its LENGTH — the model can answer starts=[1]
  // on a page of any size. `kMaxUnitWords` is where that stops being free: past the embedder's
  // window the sidecar refuses the batch and the page can never be stored at all.
  const auto tooHeavy = [&](int from, int to) {
    return wordsIn(body.substr(atoms[static_cast<std::size_t>(from)].lo,
                               atoms[static_cast<std::size_t>(to)].hi -
                                   atoms[static_cast<std::size_t>(from)].lo)) > kMaxUnitWords;
  };

  for (std::size_t i = 0; i < opens.size(); ++i) {
    const int from = opens[i] - 1;
    const int to = (i + 1 < opens.size() ? opens[i + 1] - 1 : count) - 1;
    // Split at atom boundaries until every piece fits. One atom is never split here: the grammar
    // already bounds an atom, and cutting inside one would put a boundary the model never saw —
    // and never offered — into the writer's own sentence.
    int start = from;
    for (int at = from; at <= to; ++at) {
      if (at > start && tooHeavy(start, at)) {
        const int lo = atoms[static_cast<std::size_t>(start)].lo;
        const int hi = atoms[static_cast<std::size_t>(at - 1)].hi;
        grouped.units.push_back(Passage{static_cast<int>(grouped.units.size()), lo, hi,
                                        body.substr(lo, hi - lo)});
        start = at;
      }
    }
    const int lo = atoms[static_cast<std::size_t>(start)].lo;
    const int hi = atoms[static_cast<std::size_t>(to)].hi;
    grouped.units.push_back(Passage{static_cast<int>(grouped.units.size()), lo, hi,
                                    body.substr(lo, hi - lo)});
  }
  return grouped;
}

}
