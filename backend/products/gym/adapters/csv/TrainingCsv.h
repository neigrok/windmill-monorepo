#pragma once

#include "products/gym/ports/TrainingRepository.h"

#include <string>
#include <vector>

namespace wm::gym {

// The second format gym speaks, and the sibling of adapters/json/TrainingJson: that one is the
// cross-surface contract every client parses, this one is the artifact a lifter walks away with.
// By the time a row reaches here every value in it is already text (ports/TrainingRepository.h says
// why), so the only thing left to decide is framing — and framing is all this file decides.
//
// RFC 4180: CRLF between records, a field quoted only where it holds a comma, a quote or a line
// break, and a quote inside a quoted field doubled. Nothing is edited on the way through — a note
// is the lifter's own words and travels byte for byte, because an export that rewrote the data it
// exports would not be one.
std::string toCsv(const std::vector<ExportedSet>& sets);

}
