#pragma once

#include "platform/ports/ToolHost.h"
#include "products/gym/coach/Turn.h"

#include <json/json.h>

#include <optional>
#include <string>
#include <string_view>
#include <vector>

// The ability catalog a Coach turn gates on (gym_coach.md §3): each declared tool, with the class,
// agent rule and seats Appendix C gives it. The declarations are `gymToolCatalog()`'s; this file
// is the one place the appendix is written in code, so the catalog JSON can replace it with no
// caller change.

namespace wm::gym::coach {

enum class AbilityClass { read, add, change, remove };
enum class AgentRule { runs, proposes, withheld };
enum class AbilitySeats { any, bound };
// Where a phone turn runs the ability: on the phone's replica, or — ruling R2, shares being server
// records — on the server executor.
enum class AbilityHost { phone, server };

std::string_view nameOf(AbilityClass cls);
std::string_view nameOf(AgentRule rule);

struct Ability {
  ToolDeclaration declaration;
  AbilityClass cls = AbilityClass::read;
  AgentRule agent = AgentRule::withheld;
  AbilitySeats seats = AbilitySeats::any;
  AbilityHost host = AbilityHost::phone;

  std::string name() const { return declaration.name(); }
  // G-7: a call that creates a record on the phone carries the record's id in `id`; the server mints it.
  bool mintsId() const;
};

class AbilityCatalog {
public:
  // Appendix C over the declarations; a declared name the appendix does not list is withheld.
  static AbilityCatalog of(const std::vector<ToolDeclaration>& declarations);

  const std::string& version() const { return version_; }
  const std::vector<Ability>& abilities() const { return abilities_; }
  const Ability* find(std::string_view name) const;
  // G-1 and G-2 as the tool list a seat's turn sends the vendor: declared, not withheld, and
  // admitting the seat.
  std::vector<ToolDeclaration> offered(Seat seat) const;

private:
  std::string version_ = kCatalogVersion;
  std::vector<Ability> abilities_;
};

// The catalog of record until catalog.json pins it: Appendix C over gymToolCatalog().
const AbilityCatalog& gymAbilityCatalog();

// G-3: the first way `value` breaks `schema` — type, required, additionalProperties, enum, bounds,
// lengths, pattern, item counts, uniqueItems and multipleOf, at every depth — named by its JSON
// path; nullopt when it validates.
std::optional<std::string> schemaViolation(const Json::Value& schema, const Json::Value& value);

}
