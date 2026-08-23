package works.windmill.gym.domain

// Every sentence here is a claim about backend/products/gym/adapters/mcp/GymToolCatalog.cpp.
object ConnectedLog {
    const val title = "Connected log"

    const val head = "Your training log, inside your own Claude."
    const val sub =
        "Not a coach in a chat tab. The training you have already logged, read by the assistant you " +
            "already use."

    const val sundayLabel = "Sunday, in your own Claude"
    const val sundayLine =
        "“Look at my last twelve weeks of bench. Write me a four-week block — heavier triples, and " +
            "swap the flies for incline work.”"
    const val mondayLabel = "Monday, in gym"
    const val mondayLine = "A proposal on Push A · 4 changes. You read it, you tap Apply, you train."

    val truths = listOf(
        "Nothing to install and no key to paste. The first connect opens a browser, and that screen " +
            "lists exactly what the tool asked for — product by product, level by level — to allow " +
            "or refuse. A level it was never granted is a tool it cannot see.",
        "It reads what you logged, and it writes in two ways that are not alike. What already " +
            "happened lands at once — a set, a workout, a movement, a day of the program that did " +
            "not exist. A change to a day that already stands never lands on its own: it arrives as " +
            "a diff and waits for your tap, and nothing on that connection can tap it for you.",
        "No tool can edit a set you logged, at any level. The delete level is blunter and is granted " +
            "on its own — it discards a whole workout, its sets with it, and ends a link you shared.",
    )

    const val precondition =
        "Needs an assistant you already use: Claude, or another client that speaks MCP — the setup " +
            "page walks through Claude, Cursor and Codex. If you use none of them, this one is not " +
            "for you yet, and the log stays free either way."

    const val connect = "Connect my log"

    const val onTheWeb =
        "Opens the setup page in your browser — which line to paste where. Your tool's first call " +
            "opens the approval screen itself."

    const val free = "Connecting your log is free. So is everything else in gym — there is nothing to buy here."

    const val canDoHead = "What it can do"

    const val canDo =
        "Read your sets, sessions, routines and records. Record what happened — open a workout, log " +
            "sets, add a movement, write a day of the program that did not exist. Propose a change " +
            "to a day that already stands. Mint a coach link to one workout — anybody holding that " +
            "link reads that one workout without signing in, for thirty days unless you end it " +
            "sooner."

    const val cannotDoHead = "What it cannot do"

    const val cannotDo =
        "Apply that change. There is no apply tool at any grant level, so a proposal waits on the " +
            "card until you tap it. It cannot edit a set you logged, and it cannot read or change " +
            "how your gym is set up — your rest dial and the unit you read in are yours alone."

    const val deleteLevel =
        "Delete is its own level and is never implied by write — the consent screen gives it a line " +
            "of its own. It lets a tool discard a whole workout, permanently and its sets with it, " +
            "end a coach link you have already handed out, and propose taking a day out of your " +
            "program."

    const val whereItLives =
        "Every tool you have connected is listed in your Windmill account settings on the web — what " +
            "each may do, and the Disconnect beside it. Disconnecting stops that tool's reads at " +
            "once and keeps every proposal it already made."

    const val notNamedHere = "This phone does not read that list, so it names no tool of its own."

    const val deviceOnly =
        "This log is on this device. An agent reads the log on your account, so signing in comes first."

    // Spelled off the API origin: against a split dev stack these open the API host.
    fun setupUrl(origin: String): String = "${origin.removeSuffix("/")}/#/connect"

    fun connectionsUrl(origin: String): String = "${origin.removeSuffix("/")}/#/settings"
}
