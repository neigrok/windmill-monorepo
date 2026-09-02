package works.windmill.gym.domain

// Every sentence here is a claim about backend/products/gym/adapters/mcp/GymToolCatalog.cpp.
object ConnectedLog {
    const val title = "Connected log"

    const val precondition =
        "Needs an assistant you already use: Claude, or another client that speaks MCP — the setup " +
            "page walks through Claude, Cursor and Codex. If you use none of them, this one is not " +
            "for you yet, and the log stays free either way."

    const val connect = "Connect my log"

    // The button's own icon says it opens the browser; this says what happens after.
    const val onTheWeb = "Your tool’s first call opens the approval screen."
    const val opensInBrowser = "opens in your browser"

    const val canDoHead = "What it can do"

    const val canDo =
        "Read your sets, sessions, routines, records and notes. Record what happened — open a workout, log " +
            "sets, add a movement, write a day of the program that did not exist. Propose a change " +
            "to a day that already stands. Mint a share link to one workout — anybody holding that " +
            "link reads that one workout without signing in, for 30 days unless you end it " +
            "sooner."

    const val cannotDoHead = "What it cannot do"

    const val cannotDo =
        "Apply that change. There is no apply tool at any grant level, so a proposal waits on the " +
            "card until you tap it. It cannot edit a set you logged, and it cannot read or change " +
            "how your gym is set up — your rest dial and the unit you read in are yours alone."

    const val deleteLevel =
        "Delete is its own level and is never implied by write — the consent screen gives it a line " +
            "of its own. It lets a tool discard a whole workout, permanently and its sets with it, " +
            "end a share link you have already handed out, and propose taking a day out of your " +
            "program."

    const val deviceOnly =
        "This log is on this device. An agent reads the log on your account, so signing in comes first."

    // Spelled off the API origin: against a split dev stack these open the API host.
    fun setupUrl(origin: String): String = "${origin.removeSuffix("/")}/#/connect"

    fun connectionsUrl(origin: String): String = "${origin.removeSuffix("/")}/#/settings"
}
