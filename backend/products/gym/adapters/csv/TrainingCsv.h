#pragma once

#include "products/gym/ports/AskThreadRepository.h"
#include "products/gym/ports/BodyweightRepository.h"
#include "products/gym/ports/LogRepository.h"
#include "products/gym/ports/NotesRepository.h"

#include <string>
#include <vector>

namespace wm::gym {

// RFC 4180: CRLF between records, a field quoted only where it holds a comma, a quote or a line
// break, a quote inside a quoted field doubled; a cell a spreadsheet would run as a formula gets a
// leading apostrophe.
std::string toCsv(const std::vector<ExportedSet>& sets);

std::string toCsv(const std::vector<ExportedThreadTurn>& turns);

std::string toCsv(const std::vector<ExportedNote>& notes);

std::string toCsv(const std::vector<ExportedBodyweight>& entries);

}
