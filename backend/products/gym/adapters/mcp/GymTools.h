#pragma once

#include "platform/ports/ToolHost.h"
#include "products/gym/ports/CatalogRepository.h"
#include "products/gym/ports/NotesRepository.h"
#include "products/gym/ports/ProgramRepository.h"
#include "products/gym/application/TrainingService.h"
#include "products/gym/domain/ReadReceipt.h"
#include "products/gym/ports/BodyweightRepository.h"

#include <string>

namespace wm::gym {

// Every call acts as the caller the transport authenticated, so every read and write is owner-scoped.
// CompositeToolHost has already settled the grant, so nothing here asks what a credential may do.
class GymTools : public ToolHost {
public:
  GymTools(TrainingService& training, GymWriteDoor& door, CatalogRepository& catalog, ProgramRepository& program,
           NotesRepository& notes, BodyweightRepository& bodyweight, std::string appBaseUrl);

  std::vector<ToolDeclaration> declareTools() const override;
  // The hosts above consult these after a name misses their catalog; nothing here dispatches them.
  std::vector<ToolRetirement> retiredTools() const override;
  ToolResult callTool(const std::string& name, const Json::Value& arguments,
                      const ToolCaller& caller) override;

  // The same tools through Ask. `source` is provenance; `run` is the receipt across a whole exchange,
  // merged by id, because summing replies double-counts a workout.
  ToolResult callTool(const std::string& name, const Json::Value& arguments,
                      const ToolCaller& caller, const ProposalSource& source, ReadReceipt& run);

  std::optional<ToolResult> completedAction(const UserId& user, const std::string& name, const std::string& id);

private:
  ToolResult dispatch(const std::string& name, const Json::Value& arguments, const UserId& caller,
                      const ProposalSource& source, ReadReceipt& served);

  TrainingService& training_;
  GymWriteDoor& door_;
  CatalogRepository& catalog_;
  ProgramRepository& program_;
  NotesRepository& notes_;
  BodyweightRepository& bodyweight_;   // read through `list_bodyweight` alone; no tool writes a weigh-in
  std::string appBaseUrl_;
};

}
