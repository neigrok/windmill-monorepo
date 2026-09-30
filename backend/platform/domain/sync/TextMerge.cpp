#include "platform/domain/sync/TextMerge.h"

#include <algorithm>
#include <cstdint>
#include <iterator>
#include <tuple>
#include <utility>

namespace wm::sync {

namespace {

constexpr std::pair<char32_t, char32_t> kWhitespace[] = {
    {0x0009, 0x000D}, {0x0020, 0x0020}, {0x00A0, 0x00A0}, {0x1680, 0x1680}, {0x2000, 0x200A},
    {0x2028, 0x2029}, {0x202F, 0x202F}, {0x205F, 0x205F}, {0x3000, 0x3000}, {0xFEFF, 0xFEFF}};

bool isWhitespace(char32_t point) {
  return std::any_of(std::begin(kWhitespace), std::end(kWhitespace),
                     [point](const auto& range) { return range.first <= point && point <= range.second; });
}

struct CodePoint {
  char32_t value = 0;
  std::size_t length = 1;
};

// A byte that starts no complete UTF-8 sequence reads as U+FFFD, which is not whitespace.
CodePoint codePointAt(std::string_view text, std::size_t at) {
  const auto lead = static_cast<unsigned char>(text[at]);
  if (lead < 0x80) return CodePoint{lead, 1};
  const std::size_t length = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 0;
  if (length == 0 || at + length > text.size()) return CodePoint{0xFFFD, 1};
  char32_t value = lead & (0x7F >> length);
  for (std::size_t k = 1; k < length; ++k) value = (value << 6) | (static_cast<unsigned char>(text[at + k]) & 0x3F);
  return CodePoint{value, length};
}

// A token is a maximal run, so its first code point tells whether it is whitespace.
bool isBlank(std::string_view token) {
  return !token.empty() && isWhitespace(codePointAt(token, 0).value);
}

// ECMAScript trimEnd and trimStart: a text's trailing or leading whitespace is its last or first token.
std::string_view trimEnd(std::string_view text) {
  const std::vector<std::string> tokens = tokenize(text);
  if (tokens.empty() || !isBlank(tokens.back())) return text;
  return text.substr(0, text.size() - tokens.back().size());
}

std::string_view trimStart(std::string_view text) {
  const std::vector<std::string> tokens = tokenize(text);
  if (tokens.empty() || !isBlank(tokens.front())) return text;
  return text.substr(tokens.front().size());
}

// A region that emits both sides: head without its trailing whitespace, a blank line, mine without its leading.
Diff3 conflictOf(std::string_view head, std::string_view mine) {
  return Diff3{std::string(trimEnd(head)) + "\n\n" + std::string(trimStart(mine)), true};
}

std::string textOf(const std::vector<std::string>& tokens, std::size_t from, std::size_t to) {
  std::string text;
  for (std::size_t at = from; at < to; ++at) text += tokens[at];
  return text;
}

// `x` extends `y` when `y`'s tokens are a prefix of `x`'s.
bool extends(std::string_view x, std::string_view y) {
  const std::vector<std::string> xs = tokenize(x);
  const std::vector<std::string> ys = tokenize(y);
  return ys.size() <= xs.size() && std::equal(ys.begin(), ys.end(), xs.begin());
}

enum class Side { head, mine };

// A maximal run of edits in one side's script: the base range [start, end) it replaces, and the tokens
// that replace it. A pure insertion has start == end.
struct Hunk {
  Side side;
  std::size_t start = 0;
  std::size_t end = 0;
  std::vector<std::string> tokens;

  bool isWhitespaceOnly(const std::vector<std::string>& base) const {
    for (std::size_t at = start; at < end; ++at) {
      if (!isBlank(base[at])) return false;
    }
    return std::all_of(tokens.begin(), tokens.end(), isBlank);
  }
};

std::vector<Hunk> hunksOf(const std::vector<Edit>& script, Side side) {
  std::vector<Hunk> hunks;
  std::optional<Hunk> open;
  std::size_t position = 0;
  for (const Edit& edit : script) {
    if (edit.op == EditOp::keep) {
      if (open) hunks.push_back(std::move(*open));
      open.reset();
      ++position;
      continue;
    }
    if (!open) open = Hunk{side, position, position, {}};
    if (edit.op == EditOp::remove) open->end = ++position;
    else open->tokens.push_back(edit.token);
  }
  if (open) hunks.push_back(std::move(*open));
  return hunks;
}

// Hunks of both sides chained while each next one touches the chain: the base range they span, and each
// side's hunks in base order.
struct Region {
  std::size_t start = 0;
  std::size_t end = 0;
  std::vector<Hunk> heads;
  std::vector<Hunk> mines;

  // One side's text over the region's base range: the base, with that side's hunks applied.
  std::string sideText(const std::vector<std::string>& base, const std::vector<Hunk>& hunks) const {
    std::string text;
    std::size_t position = start;
    for (const Hunk& hunk : hunks) {
      text += textOf(base, position, hunk.start);
      for (const std::string& token : hunk.tokens) text += token;
      position = hunk.end;
    }
    return text + textOf(base, position, end);
  }

  // The first rule of text/diff3.json that applies: whitespace yields to a change, a deletion to a rewrite.
  Diff3 merge(const std::vector<std::string>& base) const {
    auto whitespaceOnly = [&base](const std::vector<Hunk>& hunks) {
      return std::all_of(hunks.begin(), hunks.end(), [&base](const Hunk& hunk) { return hunk.isWhitespaceOnly(base); });
    };
    const std::string head = sideText(base, heads);
    const std::string mine = sideText(base, mines);
    const bool headBlank = whitespaceOnly(heads);
    const bool mineBlank = whitespaceOnly(mines);
    if (mines.empty()) return Diff3{head};
    if (heads.empty()) return Diff3{mine};
    if (head == mine) return Diff3{head};
    if (headBlank && mineBlank) return Diff3{head};
    if (headBlank) return Diff3{mine};
    if (mineBlank) return Diff3{head};
    if (head.empty()) return Diff3{mine};
    if (mine.empty()) return Diff3{head};
    return conflictOf(head, mine);
  }
};

// Sorted by (start, end, head first), a hunk joins the last region when it starts at or before its end.
std::vector<Region> regionsOf(std::vector<Hunk> hunks) {
  std::sort(hunks.begin(), hunks.end(),
            [](const Hunk& x, const Hunk& y) { return std::tie(x.start, x.end, x.side) < std::tie(y.start, y.end, y.side); });
  std::vector<Region> regions;
  for (Hunk& hunk : hunks) {
    if (regions.empty() || hunk.start > regions.back().end) regions.push_back(Region{hunk.start, hunk.end, {}, {}});
    Region& region = regions.back();
    region.end = std::max(region.end, hunk.end);
    (hunk.side == Side::head ? region.heads : region.mines).push_back(std::move(hunk));
  }
  return regions;
}

// §6.11 step 1: the text a delta's base names, or nullopt for a revision that is no longer kept.
std::optional<std::string> baseTextOf(std::string_view head, Seq headRev, const TextBase& base, std::string_view mine,
                                      const std::optional<std::string>& revision) {
  if (base.rev && *base.rev == headRev) return std::string(head);
  if (base.rev) return revision;
  if (!base.text.empty()) return base.text;
  if (extends(mine, head)) return std::string(head);
  if (extends(head, mine)) return std::string(mine);
  return std::string();
}

}

std::vector<std::string> tokenize(std::string_view text) {
  std::vector<std::string> tokens;
  bool previousBlank = false;
  for (std::size_t at = 0; at < text.size();) {
    const CodePoint point = codePointAt(text, at);
    const bool blank = isWhitespace(point.value);
    if (tokens.empty() || blank != previousBlank) tokens.emplace_back();
    tokens.back() += text.substr(at, point.length);
    previousBlank = blank;
    at += point.length;
  }
  return tokens;
}

std::vector<Edit> editScript(const std::vector<std::string>& from, const std::vector<std::string>& to) {
  const std::size_t n = from.size();
  const std::size_t m = to.size();
  // rest(i, j): the fewest deletes plus inserts that turn from[i..] into to[j..], row-major in one block.
  std::vector<std::uint32_t> cells((n + 1) * (m + 1));
  auto rest = [&cells, m](std::size_t i, std::size_t j) -> std::uint32_t& { return cells[i * (m + 1) + j]; };
  for (std::size_t i = n + 1; i-- > 0;) {
    for (std::size_t j = m + 1; j-- > 0;) {
      if (i == n) rest(i, j) = static_cast<std::uint32_t>(m - j);
      else if (j == m) rest(i, j) = static_cast<std::uint32_t>(n - i);
      else if (from[i] == to[j]) rest(i, j) = rest(i + 1, j + 1);
      else rest(i, j) = 1 + std::min(rest(i + 1, j), rest(i, j + 1));
    }
  }

  std::vector<Edit> script;
  std::size_t i = 0;
  std::size_t j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && from[i] == to[j]) {
      script.push_back(Edit{EditOp::keep, from[i]});
      ++i;
      ++j;
    } else if (i < n && rest(i + 1, j) + 1 == rest(i, j)) {
      script.push_back(Edit{EditOp::remove, from[i]});
      ++i;
    } else {
      script.push_back(Edit{EditOp::insert, to[j]});
      ++j;
    }
  }
  return script;
}

Diff3 diff3(std::string_view baseText, std::string_view headText, std::string_view mineText, std::size_t workCells) {
  const std::vector<std::string> base = tokenize(baseText);
  const std::vector<std::string> head = tokenize(headText);
  const std::vector<std::string> mine = tokenize(mineText);
  auto cells = [&base](const std::vector<std::string>& side) { return (base.size() + 1) * (side.size() + 1); };
  if (cells(head) > workCells || cells(mine) > workCells) return conflictOf(headText, mineText);

  std::vector<Hunk> hunks = hunksOf(editScript(base, head), Side::head);
  for (Hunk& hunk : hunksOf(editScript(base, mine), Side::mine)) hunks.push_back(std::move(hunk));

  Diff3 merged;
  std::size_t stable = 0;
  for (const Region& region : regionsOf(std::move(hunks))) {
    const Diff3 emitted = region.merge(base);
    merged.text += textOf(base, stable, region.start) + emitted.text;
    merged.conflict = merged.conflict || emitted.conflict;
    stable = region.end;
  }
  merged.text += textOf(base, stable, base.size());
  return merged;
}

std::optional<TextMerge> mergeText(std::string_view head, Seq headRev, const TextBase& base, std::string_view mine,
                                   const std::optional<std::string>& revision, std::size_t workCells) {
  const std::optional<std::string> baseText = baseTextOf(head, headRev, base, mine, revision);
  if (!baseText) return std::nullopt;
  if (mine == head) return TextMerge{std::string(head), false, *baseText};
  if (*baseText == head) return TextMerge{std::string(mine), false, *baseText};
  if (*baseText == mine) return TextMerge{std::string(head), false, *baseText};
  Diff3 merged = diff3(*baseText, head, mine, workCells);
  return TextMerge{std::move(merged.text), merged.conflict, *baseText};
}

bool mergedFlag(bool headMerged, std::string_view head, const TextMerge& merge) {
  return merge.conflict || (headMerged && merge.baseText != head);
}

}
