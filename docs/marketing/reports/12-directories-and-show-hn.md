# 12 · Give assistant users a useful first read

Lead with this job for a builder who already works in an assistant: “Open my project plan and tell me which step I can do next.” Windmill can answer from the person's own Roadmap. A second visit can tell them what changed after they marked a step complete. A Gym user can separately authorize a read of their training log. The current MCP connection covers these two products. Ordinary external MCP calls use the client's inference and give no evidence that someone will purchase Windmill One. [Public setup](https://windmill.works/connect.html) · [Product architecture](../../../STRUCTURE.md) · [Hosted AI accounting](../../AI_USAGE_REVIEW.md)

## Start with the connection we have

During the “Ship v1” pilot, offer the existing setup page to five of the 20 participants who already use a compatible client. Keep the manual path open. If fewer than five qualify, report the smaller sample. The founder watches the first attempt without driving. Engineering tests with a dedicated synthetic account first.

1. Start at `/connect.html` in a clean client. Add `https://windmill.works/mcp` as a remote Streamable HTTP server. Check that OAuth opens the correct host and the grant screen accurately describes the requested products and levels. For a first read select Roadmap read only. Provide signup and grant assistance only on request and record that attempt as assisted.
2. Have the participant open their own copy of “Ship v1” and ask which steps are available. The result should agree with the tree in the browser. A successful sign-in or list of tool names alone leaves the task incomplete.
3. Seven days later, count how many of those first readers used the connector again for their own plan. Ask what they used instead if they stopped. Count participants approached, attempted connections, grants, unaided first reads and repeat readers separately. Use observed actions or clearly labelled voluntary confirmations until cohort attribution is validated. Keep only bounded outcome labels and counts in the marketing record.

Proposed usability gate: at least four of five complete an accurate first read unaided before investing in a client listing. If two or more hit the same failure, fix that step and repeat the check. Report assisted and missing outcomes. This is a subgroup of the Roadmap pilot, with $0 incremental spend. The parent pilot's activation and return thresholds decide whether to expand recruitment. [Roadmap pilot](11-roadmap-seed-trees.md) · [Measurement](../funnels.md)

## Publish the right record

| Priority and owner | Action | Evidence for completion |
|---|---|---|
| 1 · Engineering, official MCP Registry | The November 12 registry search for “windmill” returned one latest result, the unrelated workflow platform at `windmill.dev`. Prepare a versioned `server.json` with a distinct title such as “Windmill Roadmap & Gym”, one job in the description and a `remotes` entry for `streamable-http` at the exact production endpoint. Authenticate the publishing namespace. A domain-based example is `works.windmill/roadmap-gym` with DNS or HTTPS proof. | Fetch the published registry record by name and version and compare its remote URL. This is machine-readable metadata for downstream catalogs. Each client controls its own listing and distribution. [Registry query](https://registry.modelcontextprotocol.io/v0.1/servers?search=windmill&version=latest) · [Remote server format](https://modelcontextprotocol.io/registry/remote-servers) · [Namespace verification](https://modelcontextprotocol.io/registry/authentication) |
| 2 · Founder, one client directory | Choose the client participants actually used. For Claude, an existing paid developer plan can submit a single remote connector. Prepare public privacy and support links, troubleshooting, a sample account, correct tool annotations and at least three working prompts. Track review and publish after approval. | Save the public listing URL, then use it from a fresh client. Claude's portal reports views, search terms and installs separately. [Claude submission portal guide](https://claude.com/resources/articles/build-plugins-for-claude) · [Directory requirements](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy) |
| 2 · Founder, ChatGPT if it wins that choice | Use a verified developer identity. Package the remote MCP in the required plugin ZIP. Complete the domain challenge, scans, a recorded walkthrough and the reviewer cases below. Provide dedicated reviewer sign-in that works without email codes or intervention. If that path is unavailable, keep distributing the direct setup page. | Record submission, approval and publication separately. Reinstall from the listing and repeat a read. Share reviewer credentials only in the portal's designated fields. [OpenAI submission guide](https://developers.openai.com/plugins/deploy/submission) |
| 3 · Founder, one Show HN | Once the Roadmap pilot clears its gates and a signed-out visitor can try an original public example, post the example with a short maker's note. Possible title: “Show HN: An interactive skill tree that my assistant can update.” Include the human fork path and the optional MCP setup. Answer questions as the maker. | Read attributable visits, human activations and mature returns in their own cohort. Defer a second launch until those results justify it. [Show HN guidelines](https://news.ycombinator.com/showhn.html) |

## What a reviewer can reproduce

Seed a dedicated test account with a “Ship v1” plan containing an available first step, a dependent second step and a synthetic Gym routine. Establish the appropriate grant for each case and reset the fixture between trials. Capture the exact tool names as exposed in the chosen client, expected value and observed result. Initial ChatGPT MCP review asks for five positive and three negative cases. These are drafts to run before submission. [OpenAI review format](https://developers.openai.com/plugins/deploy/submission)

| Synthetic request | Granted access | Expected behavior |
|---|---|---|
| “Which roadmaps do I own?” | Roadmap read | List the fixture plan with `list_trees`. |
| “What can I work on next in Ship v1?” | Roadmap read | Locate the tree, then use `find_nodes` for available steps. The dependent step is absent. |
| “What does the first step unlock?” | Roadmap read | Use `get_tree` and explain the planted dependency. |
| “I finished the first step. Mark it complete.” | Roadmap read and write | Resolve the node, call `set_progress` and verify the mark in the person's tree. |
| “What routines have I already saved?” | Gym read | Use `list_routines` and return the synthetic routine. |
| “How do I deploy a workflow on windmill.dev?” | Any | No personal Roadmap or Gym tool call. |
| “Summarize today's news.” | Any | No Windmill tool call. |
| “Write me a journal entry here.” | Any | No MCP Journal action or claim that it saved. |

Also try a write on the read-only Roadmap grant, a Gym read with only Roadmap access and a fresh read after disconnecting the grant in Windmill. Verify the unavailable operations stay inaccessible and no account state changes. Never include participant trees, prompts, workout details or tokens in a recording or analytics. [Authorization](../../../backend/AUTHZ.md) · [Roadmap tools](../../../backend/products/roadmap/adapters/mcp/README.md)

A browser agent that cannot find the starter is a different problem. Reproduce it with the public page and plain links first. Only if that still fails, prototype one read-only “find a public example” action with WebMCP and compare task completion on the same fixtures. Chrome's proposed WebMCP standard acts on an open page. Search distribution belongs to the indexing plan. [WebMCP status](https://developer.chrome.com/docs/ai/webmcp) · [Search runbook](06-brand-search-identity.md)
