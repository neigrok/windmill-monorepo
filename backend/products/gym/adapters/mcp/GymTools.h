#pragma once

#include "platform/ports/ToolHost.h"
#include "products/gym/application/CatalogService.h"
#include "products/gym/application/ProgramService.h"
#include "products/gym/application/TrainingService.h"
#include "products/gym/domain/ReadReceipt.h"

#include <string>

namespace wm::gym {

// The training log exposed over MCP, behind the permission gate and onto the same application core
// the phone and the web talk to. Every tool goes through one of the three services its aggregate
// lives on — TrainingService for the log, CatalogService for the movements, ProgramService for the
// routines and the proposal ledger — and none touches a repository. No tool reads the settings or a
// thread, so those two services are not held.
//
// Every call acts AS the caller — the UserId the transport authenticated — so every read and write
// is owner-scoped exactly as the HTTP handlers are. The grant was settled above by
// CompositeToolHost, so nothing here asks what a credential may do.
class GymTools : public ToolHost {
public:
  // `appBaseUrl` is where this deployment answers HTTP: a minted share is only useful to a coach as
  // a URL, and gym composes it because gym owns the route it points at (routes.cpp).
  GymTools(TrainingService& training, CatalogService& catalog, ProgramService& program,
           std::string appBaseUrl);

  std::vector<ToolDeclaration> declareTools() const override;
  // The retired names, each answering with what replaced it. Dispatched nowhere in this class: the
  // hosts above consult these after a name misses their catalog and answer with the sentence.
  std::vector<ToolRetirement> retiredTools() const override;
  ToolResult callTool(const std::string& name, const Json::Value& arguments,
                      const ToolCaller& caller) override;

  // The same tools through the other door: Ask, in this process, driving the loop itself.
  //   `source` is provenance — which door minted a proposal, and which conversation it came out of.
  //   `run` is the receipt across a whole Ask exchange. Summing the replies would count the same
  //   workout twice, so the run's total is merged BY ID here, where the ids are.
  ToolResult callTool(const std::string& name, const Json::Value& arguments,
                      const ToolCaller& caller, const ProposalSource& source, ReadReceipt& run);

private:
  // The tool itself, over the account alone, filling in what it served. callTool wraps it so every
  // failure reaches the agent naming the tool it came from, exactly once.
  ToolResult dispatch(const std::string& name, const Json::Value& arguments, const UserId& caller,
                      const ProposalSource& source, ReadReceipt& served);

  TrainingService& training_;
  CatalogService& catalog_;
  ProgramService& program_;
  std::string appBaseUrl_;
};

}
