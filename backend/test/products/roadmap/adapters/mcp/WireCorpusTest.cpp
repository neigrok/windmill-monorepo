#include "test/products/roadmap/adapters/mcp/ToolsHarness.h"

#include "test/testing.h"

#include <cstdlib>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::test;

namespace {

// The corpus schema version, written into the golden. It is a coordination signal, not an enforced
// gate: when the wire changes on purpose you regenerate the golden and, by convention, bump this so
// the version rides the same diff a reviewer reads — a pinned decoder downstream can watch this one
// int. Nothing forces the bump (regen rewrites the version and the bytes together), so it is review,
// not the compiler, that catches "same version, different bytes". What the byte-compare itself
// catches is the change that compiles green and still moves the wire — pqxx row_ref/row, jsoncpp's
// infinity, a projection that quietly grows a field.
constexpr int kWireCorpusVersion = 4;  // v4: `state` (the derived cascade) joins the full-fields read and find_nodes filters on it

// One move in the plan: a tool and its arguments. The harness fills treeId.
struct Step {
  const char* tool;
  Json::Value args;
};

Json::Value obj(std::vector<std::pair<const char*, Json::Value>> fields) {
  Json::Value value(Json::objectValue);
  for (auto& field : fields) value[field.first] = field.second;
  return value;
}

Json::Value strings(std::vector<const char*> values) {
  Json::Value array(Json::arrayValue);
  for (const char* value : values) array.append(value);
  return array;
}

// A single authoring-then-reading session, chosen so every wire shape an agent meets is on the
// record: the create / connect / recolor / rename / move / annotate / progress writes and the
// receipts they answer with, the get_tree default and full-`fields` projections, find_nodes, the
// diagnostics / progress / health reads, and an import_subgraph graft plus its dryRun collision
// preview. Client-supplied node ids + the harness StepClock keep the whole transcript reproducible.
//
// One caveat for anyone extending this plan: the golden is byte-compared, and it is generated on a
// dev machine but re-run in CI's toolchain. Every number the wire carries here is a whole value
// (positions 120/60, avgInDegree 5/5 = 1.0), which jsoncpp renders identically as "120.0" / "1.0"
// on both. Do NOT add a step whose wire carries a FRACTIONAL float (e.g. an avgInDegree of 4/3) —
// double formatting is the one thing that can differ across the split, and it would flake the
// corpus. If such a value is unavoidable, regenerate the golden inside CI's environment.
std::vector<Step> plan() {
  return {
      {"get_tree", kNoArgs},
      {"add_kind", obj({{"id", "infra"}, {"hue", "plum"}, {"label", "Infra"},
                        {"description", "the plumbing under the product"}})},
      {"create_node", obj({{"id", "root"}, {"label", "Ship v1"}, {"color", "gold"}})},
      {"create_node", obj({{"id", "render"}, {"label", "Renderer"}, {"color", "sky"},
                           {"prerequisites", strings({"root"})}})},
      {"create_node", obj({{"id", "sync"}, {"label", "Sync"}, {"color", "brick"}})},
      {"connect", obj({{"from", "root"}, {"to", "sync"}})},
      {"set_node_color", obj({{"nodeId", "sync"}, {"color", "plum"}})},
      {"rename_node", obj({{"nodeId", "render"}, {"label", "Renderer Core"}})},
      {"move_node", obj({{"nodeId", "root"}, {"x", 120}, {"y", 60}})},
      {"annotate_node", obj({{"nodeId", "root"}, {"description", "the crown of the tree"},
                             {"links", [] {
                                Json::Value link(Json::objectValue);
                                link["url"] = "https://windmill.works";
                                link["label"] = "home";
                                Json::Value array(Json::arrayValue);
                                array.append(link);
                                return array;
                              }()}})},
      {"set_progress", obj({{"nodeId", "root"}, {"status", "complete"}})},
      {"set_progress", obj({{"updates", [] {
                               Json::Value array(Json::arrayValue);
                               array.append(mark("render", "active"));
                               array.append(mark("sync", "complete"));
                               return array;
                             }()}})},
      {"import_subgraph", obj({{"nodes", [] {
                                  Json::Value array(Json::arrayValue);
                                  array.append(obj({{"id", "docs"}, {"label", "Docs"},
                                                    {"color", "olive"},
                                                    {"prerequisites", strings({"render"})}}));
                                  array.append(obj({{"id", "launch"}, {"label", "Launch"},
                                                    {"prerequisites", strings({"docs", "sync"})}}));
                                  return array;
                                }()}})},
      {"import_subgraph", obj({{"nodes", [] {
                                  Json::Value array(Json::arrayValue);
                                  array.append(obj({{"id", "root"}, {"label", "collision"}}));
                                  return array;
                                }()},
                               {"dryRun", true}})},
      // A progress-only import (nodes: []) whose carried progress names one node in the tree (root)
      // and one that isn't (ghost): the batch contract lands the first and reports the second in
      // progressSkipped, never silently. Pins that receipt shape on the wire without touching a node.
      {"import_subgraph", obj({{"nodes", Json::Value(Json::arrayValue)},
                               {"progress", [] {
                                  Json::Value array(Json::arrayValue);
                                  array.append(mark("root", "complete"));
                                  array.append(mark("ghost", "active"));
                                  return array;
                                }()}})},
      {"find_nodes", with("query", "render")},
      // The state filter — with root and sync complete and render active, `locked` is docs and
      // launch, a non-empty filtered page — plus the full vocabulary, `state` beside `status`.
      {"find_nodes", with("state", "locked")},
      {"get_tree", obj({{"fields", strings({"id", "label", "icon", "color", "order", "prerequisites",
                                            "position", "status", "seedStatus", "state", "description",
                                            "links"})}})},
      {"get_diagnostics", kNoArgs},
      {"get_progress", kNoArgs},
      {"get_health", kNoArgs},
      // Two deterministic FAILURES, so the error wire is pinned too and not just the happy path: a
      // mark on a node that does not exist (the message must name the id it could not find) and an
      // annotate with neither field to set. Errors mutate nothing, so they ride at the end.
      {"set_progress", obj({{"nodeId", "no-such-node"}, {"status", "active"}})},
      {"annotate_node", with("nodeId", "root")},
  };
}

// Parse text as JSON, keeping a valid `null` distinct from bytes that don't parse — parse() alone
// conflates the two, which would mis-file a bare-null wire as the string "null". A success wire is
// JSON; an error's is a plain message, kept verbatim.
Json::Value asWire(const std::string& text) {
  Json::CharReaderBuilder builder;
  const std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  Json::Value value;
  std::string errors;
  const bool ok = reader->parse(text.data(), text.data() + text.size(), &value, &errors);
  return ok ? value : Json::Value(text);
}

// The whole tools/call envelope an agent receives, not just content[0].text: every content block
// (type + parsed text) and structuredContent. That is what catches a tool growing an outputSchema
// and shipping its payload TWICE — structuredContent beside the text — a regression that never
// touches content[0].text, so a text-only corpus would sail straight through it.
Json::Value envelope(const ToolResult& result) {
  Json::Value content(Json::arrayValue);
  for (const Json::Value& block : result.content) {
    Json::Value entry(Json::objectValue);
    entry["type"] = block.get("type", Json::Value());
    entry["text"] = asWire(block.get("text", "").asString());
    content.append(entry);
  }
  Json::Value out(Json::objectValue);
  out["content"] = content;
  out["structuredContent"] = result.structured;
  out["isError"] = result.isError;
  return out;
}

// Run the whole plan against a fresh harness and record the transcript as one reviewable document:
// { schemaVersion, steps: [ { step, tool, result } ] }, where `result` is the full envelope above.
// jsoncpp sorts object keys, so the rendering is canonical without a separate pass.
Json::Value transcribe() {
  Harness harness;
  Json::Value document(Json::objectValue);
  document["schemaVersion"] = kWireCorpusVersion;
  Json::Value steps(Json::arrayValue);
  int index = 0;
  for (const Step& step : plan()) {
    Json::Value entry(Json::objectValue);
    entry["step"] = index++;
    entry["tool"] = step.tool;
    entry["result"] = envelope(harness.call(step.tool, step.args));
    steps.append(entry);
  }
  document["steps"] = steps;
  return document;
}

std::string render(const Json::Value& document) {
  Json::StreamWriterBuilder builder;
  builder["indentation"] = "  ";
  return Json::writeString(builder, document) + "\n";
}

std::string readFile(const std::string& path) {
  std::ifstream stream(path, std::ios::binary);
  std::stringstream buffer;
  buffer << stream.rdbuf();
  return buffer.str();
}

void writeFile(const std::string& path, const std::string& text) {
  std::ofstream stream(path, std::ios::binary | std::ios::trunc);
  stream << text;
}

// The 1-based line where two transcripts first differ, with a few lines of context from each side —
// a byte offset points nowhere a reader can act on, a line does.
void reportFirstDifference(const std::string& expected, const std::string& actual) {
  std::istringstream expectedLines(expected);
  std::istringstream actualLines(actual);
  std::string expectedLine;
  std::string actualLine;
  int line = 0;
  while (true) {
    const bool haveExpected = static_cast<bool>(std::getline(expectedLines, expectedLine));
    const bool haveActual = static_cast<bool>(std::getline(actualLines, actualLine));
    ++line;
    if (!haveExpected && !haveActual) return;
    if (!haveExpected || !haveActual || expectedLine != actualLine) {
      std::cerr << "  first difference at line " << line << ":\n"
                << "    golden: " << (haveExpected ? expectedLine : "<end of file>") << "\n"
                << "    actual: " << (haveActual ? actualLine : "<end of file>") << "\n";
      return;
    }
  }
}

}

// The MCP wire, byte-pinned. The harness is deterministic (a stepping clock, a fresh op log, a
// fixed caller, client-supplied ids), so the transcript is reproducible without scrubbing — the
// test proves that first (two independent runs must be byte-identical, which also catches a map's
// iteration order reaching the wire), then compares it to the committed golden. A drift means the
// wire moved: intended → bump kWireCorpusVersion and regenerate with WM_REGEN_WIRE_CORPUS=1;
// unintended → the change that compiled green but altered the bytes an agent reads.
TEST(mcp_wire_corpus_is_deterministic_and_matches_the_golden) {
  const std::string actual = render(transcribe());
  const std::string again = render(transcribe());
  if (actual != again) {
    reportFirstDifference(again, actual);
    ::testing::fail("MCP wire is non-deterministic across runs (an unordered iteration reached it)",
                    __FILE__, __LINE__);
    return;
  }

  const std::string path = WM_WIRE_CORPUS_PATH;
  if (std::getenv("WM_REGEN_WIRE_CORPUS")) {
    // Write the golden, then FAIL on purpose: a regeneration is never a green run. This is what
    // keeps the env var from masking drift — were it ever set in CI, the suite goes red rather than
    // silently rewriting the golden to whatever the wire now says and passing.
    writeFile(path, actual);
    std::cerr << "  regenerated MCP wire corpus (v" << kWireCorpusVersion << ", " << actual.size()
              << " bytes) at " << path << " — clear WM_REGEN_WIRE_CORPUS and re-run to verify\n";
    ::testing::fail("wire corpus regenerated — this run is intentionally not green", __FILE__, __LINE__);
    return;
  }

  const std::string golden = readFile(path);
  if (golden.empty()) {
    ::testing::fail("MCP wire corpus golden is missing — run with WM_REGEN_WIRE_CORPUS=1 to create it",
                    __FILE__, __LINE__);
    return;
  }
  if (actual != golden) {
    reportFirstDifference(golden, actual);
    ::testing::fail("MCP wire drift — if intentional, bump kWireCorpusVersion and regenerate with "
                    "WM_REGEN_WIRE_CORPUS=1",
                    __FILE__, __LINE__);
  }
}
