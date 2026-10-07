#pragma once

#include "platform/domain/Ids.h"
#include "platform/domain/sync/Record.h"

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace wm::sync {

// Whitespace is ECMAScript \s exactly: U+0009–U+000D, U+0020, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F,
// U+205F, U+3000, U+FEFF. Maximal runs of whitespace and of non-whitespace, over UTF-8 text.
std::vector<std::string> tokenize(std::string_view text);

// Every code point is that whitespace; "" is blank.
bool isBlank(std::string_view text);

enum class EditOp { keep, remove, insert };
struct Edit {
  EditOp op;
  std::string token;
};
// The lexicographically least shortest edit script under keep < remove < insert (text/script.json). It takes a
// table of (from + 1) × (to + 1) cells.
std::vector<Edit> editScript(const std::vector<std::string>& from, const std::vector<std::string>& to);

struct Diff3 {
  std::string text;
  bool conflict = false;
};
// §6.11 step 2's diff3. When either edit script, base → head or base → mine, would take more than `workCells`
// (MERGE_WORK_CELLS, Limits::mergeWorkCells), none is computed: the whole text is one conflict region,
// rtrim(head) + "\n\n" + ltrim(mine).
Diff3 diff3(std::string_view base, std::string_view head, std::string_view mine, std::size_t workCells);

struct TextMerge {
  std::string text;
  bool conflict = false;
  std::string baseText;
};
// §6.11 steps 1–2. `head` is the stored text at `headRev` ("" at rev 0 when never written). `revision` is the
// kept superseded head that a {rev} base other than headRev names, loaded by the caller; nullopt when the
// product no longer keeps it. `workCells` bounds diff3. Answers nullopt for base-unknown.
std::optional<TextMerge> mergeText(std::string_view head, Seq headRev, const TextBase& base, std::string_view mine,
                                   const std::optional<std::string>& revision, std::size_t workCells);

// §6.11 step 4's flag: conflict, or the head was merged and the base was not the head.
bool mergedFlag(bool headMerged, std::string_view head, const TextMerge& merge);

}
