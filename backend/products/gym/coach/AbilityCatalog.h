#pragma once

#include "platform/ports/ToolHost.h"
#include "products/gym/coach/Turn.h"

#include <json/json.h>

#include <optional>
#include <string>
#include <string_view>
#include <vector>

// The ability catalog a Coach turn gates on (gym_coach.md §3): each tool a catalog file declares, with the class,
// agent rule and seats Appendix C gives it. AbilityCatalogTest pins the class, agent and seats to both files.

namespace wm::gym::coach {

enum class AbilityClass { read, add, change, remove };
enum class AgentRule { runs, proposes, withheld };
enum class AbilitySeats { any, bound };
// Where a phone turn runs the ability: on the phone's replica, or — ruling R2, shares being server
// records — on the server executor.
enum class AbilityHost { phone, server };
// What a `proposes` ability proposes a change to: G-4 admits one proposal per turn for each.
enum class ProposalTarget { routine, workout };

std::string_view nameOf(AbilityClass cls);
std::string_view nameOf(AgentRule rule);

struct Ability {
  ToolDeclaration declaration;
  AbilityClass cls = AbilityClass::read;
  AgentRule agent = AgentRule::withheld;
  AbilitySeats seats = AbilitySeats::any;
  AbilityHost host = AbilityHost::phone;
  int since = kOldestCatalog;  // D-3: the catalog version that added it
  ProposalTarget target = ProposalTarget::routine;

  std::string name() const { return declaration.name(); }
  // G-7: a call that creates a record on the phone carries the record's id in `id`; the server mints it.
  bool mintsId() const;
};

class AbilityCatalog {
public:
  // Appendix C over one catalog file's declarations, as catalog/`version`; a declared name the appendix does not
  // list is withheld.
  static AbilityCatalog of(const std::vector<ToolDeclaration>& declarations, int version);
  // D-3: an older version this file still speaks for, every ability whose `since` is at most `version`.
  AbilityCatalog at(int version) const;

  int version() const { return version_; }
  const std::vector<Ability>& abilities() const { return abilities_; }
  const Ability* find(std::string_view name) const;
  // G-1 and G-2 as the tool list a seat's turn sends the vendor: declared, not withheld, and
  // admitting the seat.
  std::vector<ToolDeclaration> offered(Seat seat) const;

private:
  int version_ = kNewestCatalog;
  std::vector<Ability> abilities_;
};

// D-3: the catalogs the server serves side by side, by the version a turn opens with: catalog/1 and catalog/2 are
// catalog.json's, which builds released before catalog/3 open turns with until the cutover; catalog/3 is
// catalog-3.json's, every door's.
class ServedCatalogs {
public:
  ServedCatalogs(AbilityCatalog second, AbilityCatalog third);
  AbilityCatalog at(int version) const;

private:
  AbilityCatalog second_;
  AbilityCatalog third_;
};

// Appendix C over the embedded catalog files.
const ServedCatalogs& gymCatalogs();
// catalog/3, the newest: what MCP declares and a catalog/3 turn is gated by.
const AbilityCatalog& gymAbilityCatalog();

// G-3: the first way `value` breaks `schema` — type, required, additionalProperties, enum, bounds,
// lengths, pattern, item counts, uniqueItems and multipleOf, at every depth — named by its JSON
// path; nullopt when it validates.
std::optional<std::string> schemaViolation(const Json::Value& schema, const Json::Value& value);

}
