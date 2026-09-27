#include "platform/domain/sync/Pattern.h"

#include <algorithm>
#include <bitset>
#include <charconv>
#include <compare>
#include <cstdint>
#include <deque>
#include <functional>
#include <initializer_list>
#include <limits>
#include <map>
#include <optional>
#include <set>
#include <stdexcept>
#include <tuple>
#include <utility>
#include <vector>

namespace wm::sync {

namespace {

// §2.4's syntax characters: a pattern matches one literally only escaped.
constexpr std::string_view kSyntaxCharacters = "^$\\.*+?()[]{}|/";
// §2.4's largest repeat count.
constexpr std::uint32_t kMaxRepeat = 65'535;
// The most of `*`, `+` and `{n,}`.
constexpr std::uint32_t kUnbounded = std::numeric_limits<std::uint32_t>::max();

struct Atom;

// An atom taken from `min` to `max` times, ordered so a derivative's set holds each remainder once.
struct Item {
  const Atom* atom = nullptr;
  std::uint32_t min = 1;
  std::uint32_t max = 1;

  bool operator==(const Item&) const = default;
  std::strong_ordering operator<=>(const Item& other) const {
    if (const std::strong_ordering order = std::compare_three_way{}(atom, other.atom); order != 0) return order;
    return std::tie(min, max) <=> std::tie(other.min, other.max);
  }
};

using Sequence = std::vector<Item>;

// A byte class (a literal is a class of one byte), or a group of alternative sequences.
struct Atom {
  std::bitset<128> bytes;
  std::vector<Sequence> branches;
  bool nullable = false;  // a group one of whose branches matches the empty value
};

bool isOneOf(std::string_view characters, char c) {
  return characters.find(c) != std::string_view::npos;
}

bool nullable(const Item& item) {
  return item.min == 0 || item.atom->nullable;
}

bool nullable(const Sequence& sequence) {
  return std::all_of(sequence.begin(), sequence.end(), [](const Item& item) { return nullable(item); });
}

}

struct Pattern::Body {
  std::deque<Atom> atoms;  // a deque, so an Item's pointer stays valid as atoms are added
  Sequence top;
};

namespace {

// Reads a body into `into`'s atoms, left to right, holding each open group's branches on a stack. Answers the top
// sequence, or none for anything outside the portable subset.
class BodyReader {
public:
  BodyReader(std::string_view body, Pattern::Body& into) : body_(body), into_(into) {}

  std::optional<Sequence> top() {
    std::vector<Group> open(1);
    bool quantifiable = false;  // the last item is an atom no quantifier follows yet
    while (at_ < body_.size()) {
      const char c = body_[at_];
      if (c == '\\') {
        if (at_ + 1 == body_.size() || !isOneOf(kSyntaxCharacters, body_[at_ + 1])) return std::nullopt;
        open.back().current.push_back(Item{byteClass({body_[at_ + 1]})});
        at_ += 2;
        quantifiable = true;
      } else if (c == '[') {
        const std::optional<std::bitset<128>> bytes = bracketClass();
        if (!bytes) return std::nullopt;
        open.back().current.push_back(Item{atomOf(Atom{.bytes = *bytes})});
        quantifiable = true;
      } else if (c == '(') {
        const bool special = at_ + 1 < body_.size() && body_[at_ + 1] == '?';
        if (special && (at_ + 2 == body_.size() || body_[at_ + 2] != ':')) return std::nullopt;
        at_ += special ? 3 : 1;
        open.emplace_back();
        quantifiable = false;
      } else if (c == ')') {
        if (open.size() == 1) return std::nullopt;
        Group closed = std::move(open.back());
        open.pop_back();
        closed.branches.push_back(std::move(closed.current));
        const bool matchesEmpty = std::any_of(closed.branches.begin(), closed.branches.end(), [](const Sequence& branch) { return nullable(branch); });
        open.back().current.push_back(Item{atomOf(Atom{.branches = std::move(closed.branches), .nullable = matchesEmpty})});
        ++at_;
        quantifiable = true;
      } else if (c == '|') {
        if (open.size() == 1) return std::nullopt;
        open.back().branches.push_back(std::move(open.back().current));
        open.back().current.clear();
        ++at_;
        quantifiable = false;
      } else if (isOneOf("?*+{", c)) {
        const std::optional<std::pair<std::uint32_t, std::uint32_t>> counts = quantifier();
        if (!quantifiable || !counts) return std::nullopt;
        std::tie(open.back().current.back().min, open.back().current.back().max) = *counts;
        quantifiable = false;
      } else if (isOneOf("^$.]}", c)) {
        return std::nullopt;
      } else {
        open.back().current.push_back(Item{byteClass({c})});
        ++at_;
        quantifiable = true;
      }
    }
    if (open.size() != 1) return std::nullopt;
    return std::move(open.back().current);
  }

private:
  // A group being read: the branches before its last `|`, and the one being read.
  struct Group {
    std::vector<Sequence> branches;
    Sequence current;
  };

  const Atom* atomOf(Atom atom) {
    into_.atoms.push_back(std::move(atom));
    return &into_.atoms.back();
  }

  const Atom* byteClass(std::initializer_list<char> bytes) {
    Atom atom;
    for (const char c : bytes) atom.bytes.set(static_cast<unsigned char>(c));
    return atomOf(std::move(atom));
  }

  // A bracket class from its `[`: literals, escaped syntax characters and `\-`, and ascending ranges, with no
  // negation, no `[`, `&` or `~`, and a bare `-` only first or last. A class beginning with `:`, or holding `--`
  // escaped or not, reads differently across dialects. Its bytes, with at_ past its `]`, or none.
  std::optional<std::bitset<128>> bracketClass() {
    struct Member {
      char c;
      bool dash;  // a bare `-`, which joins its neighbours into a range
    };
    const std::size_t start = at_ + 1;
    if (start < body_.size() && (body_[start] == '^' || body_[start] == ':')) return std::nullopt;
    std::vector<Member> members;
    std::size_t i = start;
    while (i < body_.size() && body_[i] != ']') {
      if (body_[i] == '\\') {
        if (i + 1 == body_.size() || !(isOneOf(kSyntaxCharacters, body_[i + 1]) || body_[i + 1] == '-')) return std::nullopt;
        members.push_back(Member{body_[i + 1], false});
        i += 2;
      } else if (isOneOf("[&~", body_[i])) {
        return std::nullopt;
      } else {
        members.push_back(Member{body_[i], body_[i] == '-'});
        ++i;
      }
    }
    if (i == body_.size() || members.empty() || body_.substr(start, i - start).find("--") != std::string_view::npos) return std::nullopt;
    std::bitset<128> bytes;
    for (std::size_t k = 0; k < members.size(); ++k) {
      const bool range = members[k].dash && k > 0 && k + 1 < members.size();
      if (!range) {
        bytes.set(static_cast<unsigned char>(members[k].c));
        continue;
      }
      const Member& low = members[k - 1];
      const Member& high = members[k + 1];
      if (low.dash || high.dash || low.c > high.c) return std::nullopt;
      if (k + 2 < members.size() - 1 && members[k + 2].dash) return std::nullopt;
      for (int c = low.c; c <= high.c; ++c) bytes.set(static_cast<std::size_t>(c));
    }
    at_ = i + 1;
    return bytes;
  }

  // `?`, `*`, `+`, `{n}`, `{n,}` or `{n,m}` with n ≤ m ≤ kMaxRepeat: its counts, with at_ past it, or none.
  std::optional<std::pair<std::uint32_t, std::uint32_t>> quantifier() {
    const char c = body_[at_];
    if (c != '{') {
      ++at_;
      if (c == '?') return std::pair(0u, 1u);
      return std::pair(c == '*' ? 0u : 1u, kUnbounded);
    }
    const std::size_t close = body_.find('}', at_);
    if (close == std::string_view::npos) return std::nullopt;
    const std::string_view counts = body_.substr(at_ + 1, close - at_ - 1);
    const std::size_t comma = counts.find(',');
    const std::optional<std::uint32_t> low = countOf(counts.substr(0, comma));
    const std::optional<std::uint32_t> high = comma == std::string_view::npos ? low
                                              : comma + 1 == counts.size() ? std::optional(kUnbounded)
                                                                           : countOf(counts.substr(comma + 1));
    if (!low || !high || *high < *low) return std::nullopt;
    at_ = close + 1;
    return std::pair(*low, *high);
  }

  // The count a quantifier spells in decimal digits, at most kMaxRepeat, or none.
  static std::optional<std::uint32_t> countOf(std::string_view digits) {
    std::uint32_t count = 0;
    const auto [end, error] = std::from_chars(digits.data(), digits.data() + digits.size(), count);
    if (digits.empty() || error != std::errc{} || end != digits.data() + digits.size() || count > kMaxRepeat) return std::nullopt;
    return count;
  }

  std::string_view body_;
  Pattern::Body& into_;
  std::size_t at_ = 0;
};

std::shared_ptr<const Pattern::Body> bodyOf(std::string_view source) {
  const bool printable = std::all_of(source.begin(), source.end(), [](char c) { return c >= ' ' && c <= '~'; });
  if (!printable || source.size() < 2 || source.front() != '^' || source.back() != '$') return nullptr;
  auto body = std::make_shared<Pattern::Body>();
  std::optional<Sequence> top = BodyReader(source.substr(1, source.size() - 2), *body).top();
  if (!top) return nullptr;
  body->top = std::move(*top);
  return body;
}

// The derivative of a set of sequences: what each leaves to match once `byte` is read from its front.
using Derivative = std::set<Sequence>;

void derive(const Sequence& sequence, unsigned char byte, Derivative& into);

// What remains of one occurrence of `atom` once `byte` is read.
void deriveAtom(const Atom& atom, unsigned char byte, Derivative& into) {
  if (atom.branches.empty()) {
    if (byte < atom.bytes.size() && atom.bytes.test(byte)) into.insert(Sequence{});
    return;
  }
  for (const Sequence& branch : atom.branches) derive(branch, byte, into);
}

// What remains of `item` once `byte` is read: what remains of one occurrence of its atom, then the item one count
// fewer. A nullable atom's lower count never binds, since an empty occurrence fills it.
void deriveItem(const Item& item, unsigned char byte, Derivative& into) {
  if (item.max == 0) return;
  Derivative once;
  deriveAtom(*item.atom, byte, once);
  for (Sequence remainder : once) {
    if (item.max > 1) remainder.push_back(Item{item.atom, item.min > 0 ? item.min - 1 : 0, item.max == kUnbounded ? kUnbounded : item.max - 1});
    into.insert(std::move(remainder));
  }
}

void derive(const Sequence& sequence, unsigned char byte, Derivative& into) {
  for (std::size_t i = 0; i < sequence.size(); ++i) {
    Derivative remainders;
    deriveItem(sequence[i], byte, remainders);
    for (Sequence remainder : remainders) {
      remainder.insert(remainder.end(), sequence.begin() + static_cast<std::ptrdiff_t>(i) + 1, sequence.end());
      into.insert(std::move(remainder));
    }
    if (!nullable(sequence[i])) return;
  }
}

// Whether `wide` holds every value `narrow` does: the same atoms in the same places, each count range within the
// other's.
bool covers(const Sequence& wide, const Sequence& narrow) {
  if (wide.size() != narrow.size()) return false;
  for (std::size_t i = 0; i < wide.size(); ++i) {
    if (wide[i].atom != narrow[i].atom || wide[i].min > narrow[i].min || wide[i].max < narrow[i].max) return false;
  }
  return true;
}

// Drops every remainder another one covers, which leaves the values the derivative matches as they were. Two
// counted items that can read the same bytes leave one remainder per way to split what they read, and all but the
// widest are covered, so the derivative stays as small as the pattern's shape rather than growing with the value.
void dropCovered(Derivative& derivative) {
  if (derivative.size() < 2) return;
  std::map<std::vector<const Atom*>, std::vector<const Sequence*>> byShape;
  for (const Sequence& sequence : derivative) {
    std::vector<const Atom*> shape;
    for (const Item& item : sequence) shape.push_back(item.atom);
    byShape[std::move(shape)].push_back(&sequence);
  }
  std::vector<Sequence> covered;
  for (const auto& [shape, sequences] : byShape) {
    for (const Sequence* narrow : sequences) {
      const bool isCovered = std::any_of(sequences.begin(), sequences.end(), [narrow](const Sequence* wide) { return wide != narrow && covers(*wide, *narrow); });
      if (isCovered) covered.push_back(*narrow);
    }
  }
  for (const Sequence& sequence : covered) derivative.erase(sequence);
}

}

Pattern::Pattern(std::string source) : source_(std::move(source)), body_(bodyOf(source_)) {
  if (!body_) throw std::invalid_argument("the pattern " + source_ + " is outside §2.4's portable patterns");
}

bool Pattern::isPortable(std::string_view source) {
  return bodyOf(source) != nullptr;
}

bool Pattern::matches(std::string_view value) const {
  Derivative state{body_->top};
  for (const char c : value) {
    Derivative next;
    for (const Sequence& sequence : state) derive(sequence, static_cast<unsigned char>(c), next);
    if (next.empty()) return false;
    dropCovered(next);
    state = std::move(next);
  }
  return std::any_of(state.begin(), state.end(), [](const Sequence& sequence) { return nullable(sequence); });
}

}
