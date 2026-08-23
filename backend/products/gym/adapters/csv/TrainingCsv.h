#pragma once

#include "products/gym/ports/AskThreadRepository.h"
#include "products/gym/ports/LogRepository.h"

#include <string>
#include <vector>

namespace wm::gym {

// The second format gym speaks. Every value reaching here is already text (ExportedSet in
// ports/LogRepository.h), so framing is all this file decides.
//
// RFC 4180: CRLF between records, a field quoted only where it holds a comma, a quote or a line
// break, and a quote inside a quoted field doubled. A note travels byte for byte, with one
// exception: a cell a spreadsheet would RUN as a formula is prefixed with an apostrophe (see
// runsAsFormula in the .cpp for which cells those are, and why a negative load is not one).
std::string toCsv(const std::vector<ExportedSet>& sets);

// The same rule applied to a conversation: one row per TURN, the thread's own facts beside each,
// the turn itself byte for byte. A SECOND file rather than more columns on the first, because a set
// and a sentence are not one CSV shape. Both routes are parameterless and neither omits anything.
std::string toCsv(const std::vector<ExportedThreadTurn>& turns);

}
