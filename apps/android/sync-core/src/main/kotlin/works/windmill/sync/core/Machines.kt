package works.windmill.sync.core

class TransitionError : IllegalArgumentException("transition")

class StateMachine(private val rows: List<Transition>) {
    data class Transition(val from: List<String?>, val event: String, val to: List<String>)
    fun transition(from: String?, event: String, to: String? = null): String {
        val row = rows.firstOrNull { from in it.from && event == it.event } ?: throw TransitionError()
        val next = to ?: row.to.first()
        if (next !in row.to) throw TransitionError()
        return next
    }
}

object Machines {
    val intent = StateMachine(listOf(
        StateMachine.Transition(listOf(null), "commit", listOf("held", "ready")),
        StateMachine.Transition(listOf("held"), "release", listOf("ready")),
        StateMachine.Transition(listOf("held"), "undo", listOf("undone")),
        StateMachine.Transition(listOf("held"), "retire", listOf("undone")),
        StateMachine.Transition(listOf("ready"), "number", listOf("sent")),
        StateMachine.Transition(listOf("ready"), "outgrown", listOf("refused")),
        StateMachine.Transition(listOf("held", "ready"), "silent-fold", listOf("undone")),
        StateMachine.Transition(listOf("held", "ready"), "fold", listOf("refused")),
        StateMachine.Transition(listOf("held", "ready"), "target-merged", listOf("refused")),
        StateMachine.Transition(listOf("sent"), "ok", listOf("acked")),
        StateMachine.Transition(listOf("sent"), "recover", listOf("ready")),
        StateMachine.Transition(listOf("sent"), "refuse", listOf("refused")),
        StateMachine.Transition(listOf("sent"), "transport", listOf("sent")),
        StateMachine.Transition(listOf("sent"), "reidentify", listOf("ready")),
        StateMachine.Transition(listOf("sent"), "skew-return", listOf("ready")),
        StateMachine.Transition(listOf("sent"), "rewind", listOf("ready")),
        StateMachine.Transition(listOf("acked"), "resolve", listOf("resolved")),
        StateMachine.Transition(listOf("acked"), "epoch", listOf("ready")),
        StateMachine.Transition(listOf("held", "ready", "sent", "acked"), "discard", listOf("discarded")),
    ))
    val replica = StateMachine(listOf(
        StateMachine.Transition(listOf(null), "first-launch", listOf("anon")),
        StateMachine.Transition(listOf(null), "sign-in", listOf("bound")),
        StateMachine.Transition(listOf("dormant"), "sign-in", listOf("bound", "dormant")),
        StateMachine.Transition(listOf("anon"), "sign-in", listOf("bound", "deleted", "anon")),
        StateMachine.Transition(listOf("bound"), "sign-out-keep", listOf("dormant")),
        StateMachine.Transition(listOf("bound"), "sign-out-discard", listOf("deleted")),
        StateMachine.Transition(listOf("dormant"), "discard", listOf("deleted")),
        StateMachine.Transition(listOf("anon"), "reidentify", listOf("anon")),
        StateMachine.Transition(listOf("bound"), "reidentify", listOf("bound")),
        StateMachine.Transition(listOf("dormant"), "reidentify", listOf("dormant")),
    ))
}
