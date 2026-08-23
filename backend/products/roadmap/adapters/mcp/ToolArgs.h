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
// A message names the argument by its PUBLISHED spelling, the value that arrived, and the limit
// or legal set it missed. The TOOL name is stamped once by RoadmapTools::callTool, so no message
// here repeats it. Every check answers nullopt when the argument is fine and the whole sentence
// when it is not.

// Whether "" is a legal value for a required string: `rename_kind` clears a label with it,
// `create_node` has no use for a blank one.
enum class Empty { rejected, allowed };

// The handle of a thing that EXISTS, as opposed to the id you PROPOSE for a new one, which is
// always the bare `id`. Each handle is read under either spelling: `published` is the one a
// message names and the schema requires, `alias` the one accepted in silence.
struct Handle {
  const char* published;
  const char* alias;
  const char* hint;  // the next move when neither spelling is present
};

inline constexpr Handle kNodeHandle{
    "nodeId", "id", "Call get_tree with fields [\"id\",\"label\"] to list the ids this tree has."};
inline constexpr Handle kKindHandle{
    "id", "kindId", "Call get_tree and read `kinds` to list this legend's ids."};

// What a value IS ("string", "number", …) and what it SAYS (`"chartreuse"`, `5000`).
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

// A list of {url, label?} objects; a bare url string is accepted too, so both are named legal.
std::optional<std::string> optionalLinks(const Json::Value& value, const std::string& path);

// One handle out of `args`, under either spelling. `path` is blank at the top level and names
// the row inside a batch ("updates[0]").
std::optional<std::string> requireHandle(const Json::Value& args, const Handle& handle,
                                         const std::string& path, std::string& out);

}
