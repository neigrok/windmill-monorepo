package works.windmill.sync.modelserver

import works.windmill.sync.core.AccountID

sealed interface Credential {
    data object Absent : Credential
    data object Unresolved : Credential
    data class Account(val id: String) : Credential
    val account: String? get() = (this as? Account)?.id
    val fails get() = this == Unresolved || account?.let { !AccountID.isWellFormed(it) } == true
    companion object {
        fun resolve(headers: List<Pair<String, String>>, sessions: Map<String, String>): Credential {
            val sent = mutableListOf<Pair<String, String?>>()
            for ((name, value) in headers) when (asciiLower(name)) {
                "authorization" -> {
                    val token = if (value.length > 7 && asciiLower(value.take(7)) == "bearer " && value.drop(7).codePoints().noneMatch(TextMerge::isWhitespace)) value.drop(7) else null
                    sent.add("authorization" to token)
                }
                "cookie" -> for (piece in value.split(';')) {
                    val key = piece.substringBefore('=').trim(' ', '\t')
                    if (key == "wm_session") sent.add("cookie" to if ('=' in piece) piece.substringAfter('=').trim(' ', '\t').takeIf { it.isNotEmpty() } else null)
                }
            }
            if (sent.isEmpty()) return Absent
            if (sent.map { it.first }.distinct().size != sent.size) return Unresolved
            val accounts = sent.map { it.second?.let(sessions::get) }
            val account = accounts.first() ?: return Unresolved
            return if (accounts.all { it == account }) Account(account) else Unresolved
        }
        private fun asciiLower(value: String) = value.map { if (it in 'A'..'Z') it + 32 else it }.joinToString("")
    }
}
