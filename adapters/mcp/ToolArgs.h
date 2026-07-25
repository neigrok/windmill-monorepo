#pragma once

#include <json/json.h>

#include <cstddef>
#include <optional>
#include <string>
#include <vector>

namespace wm {

// One home for every argument this surface refuses, and for the sentence it refuses with:
//
//     <argument or JSON path> <what was wrong>, <what was given>, <what is legal>
//
// A caller has to be able to fix the call from the message alone — no second round trip. So a
// message names the argument by its PUBLISHED spelling (`label`, `nodes[3].label`), the value
// that arrived (its type when the type was wrong, its size when a cap was hit, its text when an
// enum missed), and the limit or legal set it missed. The TOOL name is stamped once, by
// RoadmapTools::callTool, onto whatever comes back — so no message here repeats it and none can
// forget it. Where there is an obvious next move it rides along as a second sentence; a hint
// that restates the error is noise, so most checks carry none.
//
// Every check answers nullopt when the argument is fine and the whole sentence when it is not,
// so a tool's argument contract reads as a fail-fast pipeline, top to bottom.

// Whether "" is a legal value for a required string: `rename_kind` clears a label with it,
// `create_node` has no use for a blank one.
enum class Empty { rejected, allowed };

// The handle of a thing that EXISTS, as opposed to the id you PROPOSE for a new one — which is
// always the bare `id` (create_node, add_kind, an import's nodes[]). Two concepts, deliberately
// two words. Each handle is read under either spelling so no client has to guess: `published` is
// the one a message names and the schema requires, `alias` the one still accepted in silence.
// The split runs the other way for kinds, whose published property is still `id`.
struct Handle {
  const char* published;
  const char* alias;
  const char* hint;  // the next move when neither spelling is present
};

inline constexpr Handle kNodeHandle{
    "nodeId", "id", "Call get_tree with fields [\"id\",\"label\"] to list the ids this tree has."};
inline constexpr Handle kKindHandle{
    "id", "kindId", "Call get_tree and read `kinds` to list this legend's ids."};

// What a value IS ("string", "number", …) and what it SAYS (`"chartreuse"`, `5000`) — the two
// ways a message quotes back what arrived.
std::string typeName(const Json::Value& value);
std::string literal(const Json::Value& value);

// `limit` is a byte cap on a string (0 = uncapped) or an item cap on an array.
std::optional<std::string> requireString(const Json::Value& value, const std::string& path,
                                         Empty empty = Empty::rejected, std::size_t limit = 0);
std::optional<std::string> optionalString(const Json::Value& value, const std::string& path,
                                          std::size_t limit = 0);
std::optional<std::string> requireNumber(const Json::Value& value, const std::string& path);
std::optional<std::string> optionalNumber(const Json::Value& value, const std::string& path);
std::optional<std::string> requireOneOf(const Json::Value& value, const std::string& path,
                                        const std::vector<const char*>& legal);
std::optional<std::string> optionalOneOf(const Json::Value& value, const std::string& path,
                                         const std::vector<const char*>& legal);
std::optional<std::string> requireObjects(const Json::Value& value, const std::string& path,
                                          std::size_t limit = 0);
std::optional<std::string> optionalObjects(const Json::Value& value, const std::string& path,
                                           std::size_t limit = 0);
std::optional<std::string> optionalStrings(const Json::Value& value, const std::string& path,
                                           std::size_t itemLimit = 0);
std::optional<std::string> optionalObject(const Json::Value& value, const std::string& path);

// A node's external references: a list of {url, label?} objects — a bare url string is accepted
// too (adapters/json/TreeJson linksFromJson), so both spellings are named as legal.
std::optional<std::string> optionalLinks(const Json::Value& value, const std::string& path);

// One handle out of `args`, under either of its spellings. `path` is blank at the top level and
// names the row inside a batch ("updates[0]"), so a message reads `updates[0].nodeId`.
std::optional<std::string> requireHandle(const Json::Value& args, const Handle& handle,
                                         const std::string& path, std::string& out);

}
