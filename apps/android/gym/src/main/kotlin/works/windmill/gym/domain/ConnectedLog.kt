package works.windmill.gym.domain

// THE CONNECTED LOG — the words gym puts around a grant it does not own, spelled once for the two
// places this phone says them: the invitation on Routines, and the row in gym's settings. The grant
// itself belongs to the shell and lives on a web page; what a product owes it is an honest account
// of what a connected tool may do to THIS log, and a door.
//
// §D'S HEADLINE — "The log is free. The connected log is Windmill One" — IS RETIRED, and the build
// is what retired it. NO ENTITLEMENT GATES ANYTHING IN GYM: its seventeen MCP tools ask no plan
// question, and Ask ships open behind a stated cap (Ask.dailyCap) rather than behind a purchase.
// "Gym reads no entitlement anywhere" was the first draft of that sentence and it is not true — the
// plan IS read, once, and it opens no door where it is: AskService asks
// `Entitlements::aiAllowanceFor` for the month's AI spend before a token is spent, and that function
// reads `hasWindmillOne` to pick WHICH CEILING applies (Entitlements.cpp). Nobody can hold One, so
// everybody is on the same ceiling, and no tool, no screen and no tap in this product sits behind
// it. Windmill One cannot be bought at all — `paidPlansOpen()` is a hardcoded false and BillingApi
// answers 503 while no price id is configured. A tier named here would gate nothing, could not be
// bought, and its button would lead to a checkout that 503s: three false claims in one card, in a
// product whose first rule is that no copy promises what the code does not do. So this file is the
// pitch with the price deleted, and where the price stood it says the true thing — connecting is
// free, with no countdown on it.
//
// EVERY SENTENCE BELOW IS A CLAIM ABOUT THE SERVER'S OWN TOOL CATALOG, read off
// backend/products/gym/adapters/mcp/GymToolCatalog.cpp rather than off the design:
//   · seventeen tools — seven read, seven write, three delete — and a level nobody granted is a tool
//     the connection never sees;
//   · `propose_routine_change` and `propose_routine_removal` write NOTHING. They mint a typed diff
//     that waits, and there is no apply tool at any grant level;
//   · no tool edits a logged set, at any level, and none writes the preferences that say what a
//     lifter's gym owns;
//   · `start_session`, `log_set`, `finish_session`, `create_exercise` and `create_routine` DO land
//     immediately at `write` — which is why nothing here repeats §D's "it never writes to your
//     program". A day that did not exist is a write, and the card says so;
//   · `share_session` is at `write` too, and it is THE ONE TOOL WHOSE EFFECT LEAVES THE ACCOUNT: it
//     mints the link to one workout that anybody holding it reads without signing in, for thirty
//     days (`kShareLifetimeMs`). A list of what write buys that stopped before it would leave the
//     one capability a lifter most needs named unnamed, so the card names it;
//   · `discard_session` at `delete` destroys a whole workout and every set in it, permanently —
//     which is why §D's "it cannot delete anything" is not repeated either. That level is real, it
//     is its own line on the consent screen, and the honest move is to name what it buys;
//   · `revoke_share` is at `delete` as well, so that level also buys taking a link back off a coach
//     who is reading it. The destructive reach of the level is both, and the card says both.
object ConnectedLog {
    const val title = "Connected log"

    // THE PITCH, AND IT IS ONE CONCRETE EXCHANGE rather than a protocol diagram: the sentence a
    // lifter types in their own tool on Sunday, and the object that lands in gym on Monday. Both
    // halves are drawn as an EXAMPLE in somebody else's words — this room never claims to know what
    // anybody trains, so the twelve weeks of bench belong to the quote and not to the reader.
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

    // THE THREE FACTS UNDER THE EXCHANGE, and each is the narrowest true version of the design's
    // bullet rather than the design's own wording. §D said "it reads, it proposes, it never writes
    // to your program" and "one subscription, all three Windmill products"; the first is false at
    // `write` (a new day lands immediately) and the second names a subscription nobody can buy.
    val truths = listOf(
        // "A level you withhold" was the first draft and it is not what the consent screen does:
        // it lists the request and offers Allow or Cancel, so what a lifter withholds is the whole
        // grant. What IS true is the other half — a level that was never granted is a tool the
        // connection cannot so much as list.
        "Nothing to install and no key to paste. The first connect opens a browser, and that screen " +
            "lists exactly what the tool asked for — product by product, level by level — to allow " +
            "or refuse. A level it was never granted is a tool it cannot see.",
        // BOTH HALVES OF THE SPLIT, and the flattering half alone was what this bullet said first.
        // "It reads, and it proposes" describes `propose_routine_change` and describes nothing else
        // `write` reaches: `create_routine` lands a day that did not exist with no tap at all. A
        // safety promise that is nearly true is the one that gets believed, so the bullet is longer
        // than the design's and says what actually lands.
        "It reads what you logged, and it writes in two ways that are not alike. What already " +
            "happened lands at once — a set, a workout, a movement, a day of the program that did " +
            "not exist. A change to a day that already stands never lands on its own: it arrives as " +
            "a diff and waits for your tap, and nothing on that connection can tap it for you.",
        "No tool can edit a set you logged, at any level. The delete level is blunter and is granted " +
            "on its own — it discards a whole workout, its sets with it, and ends a link you shared.",
    )

    // THE PRECONDITION, AND IT IS THE MOST HONEST LINE ON THE CARD: this one needs something the
    // lifter already has, and a person who has none of them is told so rather than sold to. The clients
    // named are the ones windmill.works/connect.html actually walks through — naming a tool we have
    // written no instructions for would be the same defect one size smaller.
    const val precondition =
        "Needs an assistant you already use: Claude, or another client that speaks MCP — the setup " +
            "page walks through Claude, Cursor and Codex. If you use none of them, this one is not " +
            "for you yet, and the log stays free either way."

    const val connect = "Connect my log"

    // A TAP THAT LEAVES THE APP SAYS SO BEFORE IT IS TAPPED. The grant is a web page and this phone
    // has no screen for it, so the button opens a browser — which is the most a surface can honestly
    // do about a door it does not hold. And it says what that page IS: the setup page tells a client
    // where to point, and the approval screen is opened by the CLIENT on its first call, which is
    // neither this app's screen nor the page this button opens.
    const val onTheWeb =
        "Opens the setup page in your browser — which line to paste where. Your tool's first call " +
            "opens the approval screen itself."

    // WHERE THE PRICE WAS. Not "free for now", no countdown and no founder's rate — those are the
    // manufactured urgency this brand refuses, and every one of them would be a claim about a future
    // nobody has decided. If a paid line ever arrives here it arrives with a checkout that works,
    // and that wave rewrites this line.
    const val free = "Connecting your log is free. So is everything else in gym — there is nothing to buy here."

    // THE GRANT, IN THE LIFTER'S WORDS (§D screen 13). The consent screen itself is the shell's and
    // is not rebuilt here; these are the two lists gym owes a person deciding, and both are the
    // catalog's own split rather than a summary of it.
    const val canDoHead = "What it can do"

    // THE SHARE IS IN THIS LIST BECAUSE IT IS THE ONE THING HERE THAT LEAVES THE ACCOUNT.
    // `share_session` sits at `write` beside the logging tools, so a lifter who allows write has
    // allowed it — and every other capability on this card moves numbers around inside their own
    // log, where this one hands one workout to whoever holds a URL. Naming the small writes and
    // stopping before the one with a reader outside the room would be the omission that matters.
    const val canDo =
        "Read your sets, sessions, routines and records. Record what happened — open a workout, log " +
            "sets, add a movement, write a day of the program that did not exist. Propose a change " +
            "to a day that already stands. Mint a coach link to one workout — anybody holding that " +
            "link reads that one workout without signing in, for thirty days unless you end it " +
            "sooner."

    const val cannotDoHead = "What it cannot do"

    // "It cannot say what plates your gym owns" was the first draft of the last clause and it says
    // the opposite of the truth to anybody reading quickly: `get_preferences` is a READ tool, so a
    // connection can indeed say what your gym owns. What no level has is a WRITE for it — there is
    // no twin to that tool anywhere in the catalog — so the sentence is about changing them now.
    const val cannotDo =
        "Apply that change. There is no apply tool at any grant level, so a proposal waits on the " +
            "card until you tap it. It cannot edit a set you logged, and it cannot change how your " +
            "gym is set up — your bar, your plates and your rest dial can be read, and no level " +
            "writes them."

    // THE LEVEL THE DESIGN'S CARD DENIED EXISTS. "It cannot delete anything" is false the moment a
    // lifter grants delete, and a card that said otherwise would be the one sentence somebody
    // believed right up until a workout was gone.
    //
    // ALL THREE OF ITS TOOLS ARE NAMED, and the coach link is the one a summary would drop:
    // `revoke_share` ends a link a lifter handed out, which is the same kind of loss as the workout
    // — something they were relying on, gone at somebody else's tap. A level is only approvable if
    // what it reaches is on the page.
    const val deleteLevel =
        "Delete is its own level and is never implied by write — the consent screen gives it a line " +
            "of its own. It lets a tool discard a whole workout, permanently and its sets with it, " +
            "end a coach link you have already handed out, and propose taking a day out of your " +
            "program."

    // WHERE THE CONNECTIONS ACTUALLY LIVE, and §D got this one wrong too: its card says "disconnect
    // any time in Settings → Gym → Connected log", and there is no such control on any surface. The
    // list of connected tools, what each may do, and the Disconnect beside it are the SHELL's, in
    // account settings on the web (ConnectedToolsSection), because a grant is the account's and not
    // one product's. Disconnecting really is immediate: revoking a grant deletes its tokens in the
    // same transaction, so the next call resolves nothing.
    const val whereItLives =
        "Every tool you have connected is listed in your Windmill account settings on the web — what " +
            "each may do, and the Disconnect beside it. Disconnecting stops that tool's reads at " +
            "once and keeps every proposal it already made."

    // THE FRESHNESS THIS PHONE CANNOT OBSERVE, said as the absence it is. §D draws each row as
    // `connected · read 2h ago`; the connections are the account's and gym does not read them, so
    // this row names none — a card that invented a state it never observed is the same defect as a
    // receipt counting rows it never served.
    const val notNamedHere = "This phone does not read that list, so it names no tool of its own."

    // ANONYMOUS-FIRST IS THE ROOM'S FIRST STATE, and a grant needs an account to be granted against.
    // Said plainly rather than by hiding the row: what is on this device is not reachable by
    // anybody's agent, and that is a fact about the log rather than a reason to sign in.
    const val deviceOnly =
        "This log is on this device. An agent reads the log on your account, so signing in comes first."

    // THE TWO WEB PAGES THIS ROOM POINTS AT, and they are two because the web keeps them apart: the
    // SETUP page says which line to paste into which client, and the account's CONNECTIONS list —
    // what is connected, what it may do, and Disconnect — is a section of settings. The invitation
    // wants the first; a lifter reading gym's settings wants the second, which carries its own way
    // on to the first.
    //
    // BOTH ARE SPELLED OFF THE ACCOUNT'S OWN ORIGIN, so a build pointed at a local server sends a
    // lifter to that server and never to windmill.works.
    //
    // WHICH IS A GUESS THIS PHONE IS MAKING, AND THE SHARE LINK IS WHERE THAT GUESS IS ALREADY
    // WRITTEN DOWN (`CoachShare.link`): this app knows where the API answers and does NOT know where
    // the browser app is served. In production they are one host and this is exact. Against a stack
    // where they are two — the emulator on `10.0.2.2:8088` with vite on another port — it opens the
    // API host, which does not serve this page. The share got out of that by preferring a URL the
    // SERVER composes and falling back to this only against an older backend; nothing on the wire
    // carries a connect URL, so there is nothing here to prefer. A `connectUrl` from the server
    // would close it, and until then this is a dev-only wrong host rather than a link that opens the
    // wrong thing.
    fun setupUrl(origin: String): String = "${origin.removeSuffix("/")}/#/connect"

    fun connectionsUrl(origin: String): String = "${origin.removeSuffix("/")}/#/settings"
}
