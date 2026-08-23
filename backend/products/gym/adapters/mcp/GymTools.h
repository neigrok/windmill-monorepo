#pragma once

#include "platform/ports/ToolHost.h"
#include "products/gym/application/CatalogService.h"
#include "products/gym/application/ProgramService.h"
#include "products/gym/application/TrainingService.h"
#include "products/gym/domain/ReadReceipt.h"

#include <string>

namespace wm::gym {

// The training log exposed over MCP. Every call acts AS the caller — the UserId the transport
// authenticated — so every read and write is owner-scoped exactly as the HTTP handlers are. The
// grant was settled above by CompositeToolHost, so nothing here asks what a credential may do.
class GymTools : public ToolHost {
public:
  GymTools(TrainingService& training, CatalogService& catalog, ProgramService& program,
           std::string appBaseUrl);

  std::vector<ToolDeclaration> declareTools() const override;
  // Dispatched nowhere in this class: the hosts above consult these after a name misses their
  // catalog and answer with the sentence.
  std::vector<ToolRetirement> retiredTools() const override;
  ToolResult callTool(const std::string& name, const Json::Value& arguments,
                      const ToolCaller& caller) override;

  // The same tools through Ask, in this process. `source` is provenance; `run` is the receipt
  // across a whole Ask exchange, merged BY ID here because summing replies double-counts a workout.
  ToolResult callTool(const std::string& name, const Json::Value& arguments,
                      const ToolCaller& caller, const ProposalSource& source, ReadReceipt& run);

private:
  ToolResult dispatch(const std::string& name, const Json::Value& arguments, const UserId& caller,
                      const ProposalSource& source, ReadReceipt& served);

  TrainingService& training_;
  CatalogService& catalog_;
  ProgramService& program_;
  std::string appBaseUrl_;
};

}
