# Connect tool setup verification

The Connect page offers ChatGPT by OpenAI first, followed by Claude Desktop, Claude Code,
Cursor, Codex, and Any client. ChatGPT setup uses the Windmill remote MCP endpoint with OAuth.
The page links to OpenAI’s setup guide and notes that availability depends on the account and
workspace settings. The API key disclosure provides the fallback for clients without OAuth.

## Verified locally

- `npm run build` passed: 1,727 tests passed, with zero failures or skips, followed by the production build.
- The backend rebuilt successfully. Local OAuth metadata and MCP initialization checks passed.
- Browser checks covered desktop at 1280px in light and dark themes, and mobile at 390px and
  320px in the dark theme.
- All six client panels were exercised. Native arrow-key navigation selected Claude, signed-out
  Copy opened sign-in, and the API key disclosure opened and closed.
- Five interaction regressions cover ChatGPT’s default selection and setup instructions, exact
  clipboard content for every client, pending and successful copy states, clipboard rejection,
  stale completion after a tool change, signed-out sign-in gating, the API key fallback, and Codex’s
  explicit OAuth login instructions and official guide.

## Verification limits

The external ChatGPT OAuth handshake has not been run because no test ChatGPT connection is
configured. Local OAuth discovery and MCP initialization do not establish that external handshake.

The dogfood tree could not be updated: local MCP `get_tree` for `t_9362d9bc883e0a1e` returned
`no such tree`, and no connected Windmill MCP tool was exposed.

## Structure observations

Each client owns one configuration string used for both display and clipboard content, keeping
those representations consistent. The page uses native radio controls for tool selection and one
shared setup layout. Its clipboard request counter prevents a completed request from updating a
different client’s feedback. Connection setup guidance carries no simulated connection status.

The small feature remains in one cohesive component; additional provider classes or rendering
helpers would add indirection without a separate responsibility. API key management remains in
its existing dedicated panel.
