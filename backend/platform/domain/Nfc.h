#pragma once

#include <string>
#include <string_view>

namespace wm {

// Unicode Normalization Form C (UAX #15), the form text enters a store in (gym_coach.md §3.3): "e" + U+0301 is
// U+00E9, a Hangul jamo run is its syllable. Bytes that are not well-formed UTF-8 come back exactly as they arrived,
// for the caller's storable-text check to refuse; they are never repaired here.
std::string nfc(std::string_view text);

}
