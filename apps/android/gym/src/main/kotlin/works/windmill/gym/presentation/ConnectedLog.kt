package works.windmill.gym.presentation

import androidx.annotation.StringRes
import kotlinx.serialization.Serializable
import works.windmill.gym.R
import works.windmill.platform.i18n.Words
import works.windmill.platform.i18n.joined

// The screen where a lifter hands their log to their own AI, its strings pinned byte for byte by
// `ConnectedLogTests`. Every level row is a claim about backend/products/gym/adapters/mcp/GymToolCatalog.cpp
// and nothing else — the enumeration is the disclosure.
object ConnectedLog {
    // The whole of the long form: two levels of disclosure, and this is the second.
    val howItWorks = listOf(R.string.gym_connected_how_url, R.string.gym_connected_how_share, R.string.gym_connected_how_no_apply,
        R.string.gym_connected_how_delete, R.string.gym_connected_how_end)

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

// One row per level, in the ladder's order. `wire` is the level's spelling in a scope token; `held` is how a connected row's description names it.
enum class LogLevel(val wire: String, @StringRes val named: Int, @StringRes val reaches: Int, @StringRes val held: Int) {
    Read("read", R.string.gym_connected_level_read, R.string.gym_connected_level_read_meta, R.string.gym_connected_level_read_held),
    Write("write", R.string.gym_connected_level_write, R.string.gym_connected_level_write_meta, R.string.gym_connected_level_write_held),
    Delete("delete", R.string.gym_connected_level_delete, R.string.gym_connected_level_delete_meta, R.string.gym_connected_level_delete_held),
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
    val words: Words?
        get() = if (accountWide) Words.Message(R.string.gym_connected_whole_account)
        else LogLevel.entries.filter(levels::contains).map { Words.Message(it.held) }.joined()
}

// One credential that reaches the training log. `sinceMs` is the day it came into being — for a
// grant, the earliest across every refresh. The wire's `lastUsedMs` is not carried: it is a
// last-used, and a row would read it as a last-read.
data class ConnectedTool(
    val id: String,
    val named: Words,
    val sinceMs: Long,
    val reach: LogReach,
    val credential: Credential,
) {
    enum class Credential { Approved, Pasted }

    constructor(grant: OAuthGrant) : this(
        id = grant.clientId,
        named = grant.name.trim().takeIf { it.isNotEmpty() }?.let(Words::Plain) ?: Words.Message(R.string.gym_connected_unnamed_grant),
        sinceMs = grant.grantedMs,
        reach = LogReach(grant.scope),
        credential = Credential.Approved,
    )

    // Every static key is the account-wide grant, and the list endpoint serves no scope, so the reach
    // is stated here rather than decoded.
    constructor(key: McpKey) : this(
        id = key.id,
        named = key.name.trim().takeIf { it.isNotEmpty() }?.let(Words::Plain) ?: Words.Message(R.string.gym_connected_unnamed_key),
        sinceMs = key.createdMs,
        reach = LogReach(""),
        credential = Credential.Pasted,
    )

    // The levels it holds, then when it was made — never a last read.
    fun described(now: Long): Words {
        val since = Words.Message(R.string.gym_connected_since, listOf(Readout.shortDate(sinceMs, now)))
        val key = Words.Message(R.string.gym_connected_api_key).takeIf { credential == Credential.Pasted }
        return checkNotNull(listOfNotNull(key, reach.words, since).joined())
    }
}

// Unknown and failed reads make no claim about existing credentials; None is an answered empty pair.
sealed interface ConnectedLogState {
    data object Unknown : ConnectedLogState
    data object Refused : ConnectedLogState
    data object Offline : ConnectedLogState
    data object None : ConnectedLogState
    data class Connected(val tools: List<ConnectedTool>) : ConnectedLogState

    // Whether the shell has answered for the seat: a store holding an answer does not ask again.
    val answered: Boolean get() = this is None || this is Connected
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
