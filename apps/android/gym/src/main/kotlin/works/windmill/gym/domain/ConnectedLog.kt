package works.windmill.gym.domain

import kotlinx.serialization.Serializable

// The screen where a lifter hands their log to their own AI: docs/design/gym/briefs/19-connected-log.md,
// byte for byte. Every level row is a claim about backend/products/gym/adapters/mcp/GymToolCatalog.cpp
// and nothing else — the enumeration is the disclosure.
object ConnectedLog {
    const val title = "Connected log"
    const val head = "Your log, read by Claude, Cursor or Codex."
    const val caption = "A routine change waits for your Apply; the rest lands at once."
    const val action = "Connect a tool"
    const val actionSignedOut = "Sign in first"
    const val opensInBrowser = "opens in your browser"
    const val disclosure = "How this works"
    // The disclosure's state, in the bytes a screen reader hears.
    const val open = "open"
    const val closed = "closed"

    // The whole of the long form: two levels of disclosure, and this is the second.
    val how = listOf(
        "One URL pasted into your tool. Your browser opens once to approve.",
        "A shared workout is public for 30 days, until you end it.",
        "No tool can apply a proposal or edit a logged set.",
        "Delete is approved on its own, and a discard is permanent.",
        "End a connection under Settings → Connected tools; a key under API keys.",
    )

    const val connectedHead = "Connected"
    const val unnamedGrant = "A connected tool"
    const val unnamedKey = "A static key"
    const val unread = "Couldn’t read your connections."
    const val manage = "Manage connections"
    const val accountWide = "whole account"
    const val apiKey = "API key"

    const val settingsUnknown = "your AI tools"
    const val settingsNone = "nothing connected yet"

    // Spelled off the API origin: against a split dev stack these open the API host.
    fun setupUrl(origin: String): String = "${origin.removeSuffix("/")}/#/connect"

    fun connectionsUrl(origin: String): String = "${origin.removeSuffix("/")}/#/settings"

    // Both lists or neither is the caller's rule; this only says what the two lists mean together. A
    // grant that reaches no gym level is another product's and is not drawn.
    fun state(grants: List<OAuthGrant>, keys: List<McpKey>): ConnectedLogState {
        val approved = grants.map { ConnectedTool(it) }.filter { it.reach.reachesTheLog }
        val pasted = keys.map { ConnectedTool(it) }
        val tools = approved + pasted
        if (tools.isEmpty()) return ConnectedLogState.None
        return ConnectedLogState.Connected(tools)
    }
}

// One row per level, in the ladder's order. `wire` is the level's spelling in a scope token and in
// a connected row's meta.
enum class LogLevel(val label: String, val meta: String) {
    Read("Read", "sets, workouts, routines, records, notes, weigh-ins"),
    Write("Write", "logs sets · adds routines · shares workouts · proposes changes"),
    Delete("Delete", "discards a workout · ends a share");

    val wire: String get() = label.lowercase()
}

// What one grant reaches in gym, read from the OAuth scope string. The empty scope is the
// account-wide grant and confers everything; a token nobody can parse confers nothing; the two are
// never collapsed. Levels never imply each other.
data class LogReach(val levels: Set<LogLevel>, val accountWide: Boolean) {
    constructor(scope: String) : this(
        levels = if (scope.isBlank()) LogLevel.entries.toSet()
        else LogLevel.entries.filter { "gym:${it.wire}" in scope.split(' ', '\t', '\n', '\r') }.toSet(),
        accountWide = scope.isBlank(),
    )

    val reachesTheLog: Boolean get() = accountWide || levels.isNotEmpty()

    // The levels held, joined in the ladder's order rather than a Set's; account-wide reads as one.
    val line: String
        get() = if (accountWide) ConnectedLog.accountWide
        else LogLevel.entries.filter(levels::contains).joinToString(" · ") { it.wire }
}

// One credential that reaches the training log. `sinceMs` is the day it came into being — for a
// grant, the earliest across every refresh. The wire's `lastUsedMs` is not carried: it is a
// last-used, and a row would read it as a last-read.
data class ConnectedTool(
    val id: String,
    val name: String,
    val sinceMs: Long,
    val reach: LogReach,
    val credential: Credential,
) {
    enum class Credential { Approved, Pasted }

    constructor(grant: OAuthGrant) : this(
        id = grant.clientId,
        name = grant.name.trim().ifEmpty { ConnectedLog.unnamedGrant },
        sinceMs = grant.grantedMs,
        reach = LogReach(grant.scope),
        credential = Credential.Approved,
    )

    // Every static key is the account-wide grant, and the list endpoint serves no scope, so the reach
    // is stated here rather than decoded.
    constructor(key: McpKey) : this(
        id = key.id,
        name = key.name.trim().ifEmpty { ConnectedLog.unnamedKey },
        sinceMs = key.createdMs,
        reach = LogReach(""),
        credential = Credential.Pasted,
    )

    // The levels it holds, then when it was made — never a last read.
    fun meta(now: Long): String {
        val since = "since ${Readout.shortDate(sinceMs, now)}"
        if (credential == Credential.Pasted) return "${ConnectedLog.apiKey} · ${reach.line} · $since"
        return "${reach.line} · $since"
    }
}

// `Unknown` is nothing asked yet for the seat in hand and `Refused` is a read that did not come
// back; both say nothing at all. `None` is a real answer.
sealed interface ConnectedLogState {
    data object Unknown : ConnectedLogState
    data object Refused : ConnectedLogState
    data object None : ConnectedLogState
    data class Connected(val tools: List<ConnectedTool>) : ConnectedLogState

    // Whether the shell has answered for the seat: a store holding an answer does not ask again.
    val answered: Boolean get() = this is None || this is Connected

    // The settings row's meta: the state and nothing else.
    val settingsMeta: String
        get() = when (this) {
            Unknown, Refused -> ConnectedLog.settingsUnknown
            None -> ConnectedLog.settingsNone
            is Connected -> tools.singleOrNull()?.let { "${it.name} · ${it.reach.line}" }
                ?: "${tools.size} tools"
        }
}

// One row of `GET /v1/oauth/grants`. `lastUsedMs` rides the wire and is not decoded.
@Serializable
data class OAuthGrant(
    val clientId: String,
    val name: String = "",
    val grantedMs: Long,
    val scope: String = "",
)

// One row of `GET /v1/mcp-keys`. The endpoint serves no scope.
@Serializable
data class McpKey(val id: String, val name: String = "", val createdMs: Long)
