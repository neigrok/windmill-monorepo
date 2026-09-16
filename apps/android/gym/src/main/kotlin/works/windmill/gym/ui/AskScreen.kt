package works.windmill.gym.ui

import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import works.windmill.gym.domain.Ask
import works.windmill.gym.domain.AskAnswer
import works.windmill.gym.domain.AskCap
import works.windmill.gym.domain.AskExchange
import works.windmill.gym.domain.ConnectedLog
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Threads
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.ProposalRead
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace
import works.windmill.platform.net.WindmillJson

// Coach reads the log and proposes; it cannot edit or delete a logged set — the server hands the
// model the reads plus the two propose tools, filtered at list time AND checked again at call time.
// `cap` is an allowance having run out — the day's ten or the account's 30-day ceiling: the
// composer's input and send control come down, and in their place stand the new-conversation door
// and the connect door — the one path that is not rationed under either. The moment it ran out
// reads at the END OF THE THREAD, inside the scroller; only the two doors, and the allowance where
// it is still true, are pinned. The state says the sentence the log sent; the refusal that raised it
// is not drawn a second time above it.
@Composable
fun AskScreen(
    store: TrainingStore,
    thread: List<AskExchange>,
    // Ephemeral lines derived from the server's apply reply; they die with the conversation.
    receipts: List<String>,
    // Reviews opened and closed with nothing decided: those cards read `still waiting`.
    lookedAt: Set<String>,
    asking: Boolean,
    cap: AskCap?,
    onAsk: (String) -> Unit,
    onRetry: () -> Unit,
    onAskNew: () -> Unit,
    seed: String,
    origin: String,
    backTo: String? = null,
    onBack: (() -> Unit)? = null,
    seat: String? = null,
    onThreads: () -> Unit,
    onNotes: () -> Unit,
    onReview: (Proposal) -> Unit,
    onConnections: (() -> Unit)? = null,
    onNewDraft: (String) -> Unit = { onAskNew() },
    conversationId: String = "",
) {
    val skin = LocalGymColors.current
    val nowMs = System.currentTimeMillis()
    val scroll = rememberScrollState()

    // Read back off the log: the reply carries ids only. A proposal moves when anybody decides, and a
    // decision taken in this room overrides the copy read here, so the card and the receipt agree.
    val minted = remember { mutableStateMapOf<String, Proposal>() }
    val failures = remember { mutableStateMapOf<String, String>() }
    val missing = remember { mutableStateMapOf<String, Boolean>() }
    var attempt by remember { mutableStateOf(0) }
    val wanted = thread.flatMap { it.answer?.proposals.orEmpty() }
    LaunchedEffect(wanted, attempt) {
        wanted.forEach { id ->
            if (minted.containsKey(id) || missing.containsKey(id)) return@forEach
            val read = store.proposal(id)
            when (read) {
                is ProposalRead.Found -> { minted[id] = read.proposal; failures.remove(id) }
                ProposalRead.Gone -> { missing[id] = true; failures.remove(id) }
                is ProposalRead.Failed -> failures[id] = read.why.line("the proposal wasn’t read")
            }
        }
    }

    val questionPositions = remember(conversationId, thread.isEmpty()) { mutableStateMapOf<Int, Int>() }
    var tailTop by remember(conversationId, thread.isEmpty()) { mutableIntStateOf(0) }
    val lastQuestion = questionPositions[thread.lastIndex] ?: 0
    var visibleCount by remember { mutableStateOf(thread.size) }
    LaunchedEffect(thread.size) {
        if (thread.size > visibleCount) {
            val top = snapshotFlow {
                questionPositions[thread.lastIndex]?.takeIf { scroll.maxValue >= it }
            }.filterNotNull().first()
            scroll.animateScrollTo(top)
        }
        visibleCount = thread.size
    }

    GymScreen(
        title = Ask.title,
        onBack = onBack,
        backTo = backTo,
        actions = {
            TopAction(Threads.door, onClick = onThreads)
            seat?.let { YouSeat(it) }
        },
    ) {
      Column(
        Modifier
            .fillMaxSize()
            .imePadding(),
      ) {
        Head(onNotes)
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            // The latest question can reach the top while its reply is short or still pending.
            val tailHeight = (maxHeight - with(LocalDensity.current) { (tailTop - lastQuestion).toDp() }).coerceAtLeast(0.dp)
            Column(
                verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(scroll)
                    .padding(horizontal = GymLayout.gutter)
                    .padding(top = GymLayout.contentTop, bottom = WindmillSpace.x2),
            ) {
                if (thread.isEmpty()) Opening(origin, onConnections)
                thread.forEachIndexed { index, exchange ->
                    Box(Modifier.fillMaxWidth().onGloballyPositioned {
                        questionPositions[index] = it.positionInParent().y.toInt()
                    }) { CoachQuestion(exchange.question) }
                    if (exchange.pending) {
                        Text(Ask.waiting, style = WindmillFont.body(12).copy(lineHeight = 17.sp), color = skin.inkDim)
                    }
                    exchange.answer?.let { answered ->
                        Answer(answered, minted + store.settledProposals, store.catalog, nowMs, lookedAt, onReview)
                        answered.proposals.filter { it !in minted && it !in store.settledProposals }.forEach { id ->
                            if (id in missing) Trouble(ProposalRead.Gone.line, null)
                            else failures[id]?.let { Trouble(it) { failures.remove(id); attempt += 1 } }
                                ?: Text("Reading proposal…", style = WindmillFont.body(14), color = skin.inkDim)
                        }
                    }
                    exchange.trouble?.let { said ->
                        // The cap-reached state says this refusal once, at the end of the thread just
                        // below; it is not drawn twice.
                        if ((cap != null || exchange.needsNew) && index == thread.lastIndex) return@let
                        Trouble(
                            said = said,
                            // Only the NEWEST question may be asked again.
                            onRetry = onRetry.takeIf {
                                exchange.again && !asking && index == thread.lastIndex
                            },
                        )
                    }
                }
                val shown = (minted + store.settledProposals).values.mapNotNull { it.receipt }.toSet()
                receipts.filterNot { it in shown }.forEach { ReceiptLine(it) }
                // The moment the allowance ran out, at the end of the conversation it stopped. It reads
                // INSIDE the scroller, because the block below does not scroll and anything pinned there
                // comes off the thread: with this sentence scrolling, the thread keeps 283.5dp at
                // fontScale 2.0 — measured in `LargestTypeTests`, the one file in this suite with real
                // font metrics.
                cap?.let {
                    Text(
                        thread.lastOrNull()?.trouble ?: it.wordless,
                        style = WindmillFont.body(15).copy(lineHeight = 22.sp),
                        color = skin.ink,
                    )
                }
                if (thread.isNotEmpty()) Spacer(Modifier.fillMaxWidth().height(tailHeight)
                    .onGloballyPositioned { tailTop = it.positionInParent().y.toInt() })
            }
        }
        // The allowance sits immediately above the composer — where a question is spent — and it is
        // a promise about the DAY's ten, so it stands under the daily cap too. Under the account's
        // 30-day ceiling it is not the rule that stopped this question: drawn on top of the sentence
        // that says so, it would read as the reason and be the one lie in the room.
        Column(
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = GymLayout.gutter)
                .padding(top = WindmillSpace.x2, bottom = WindmillSpace.x3),
        ) {
            if (cap != AskCap.Ceiling) {
                Text(Ask.allowance, style = WindmillFont.body(12).copy(lineHeight = 17.sp), color = skin.inkDim)
            }
            when {
                cap != null -> CapDoors(cap, origin, onAskNew, onConnections)
                Ask.needsNew(thread) -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(thread.lastOrNull()?.takeIf { it.needsNew }?.trouble ?: Ask.threadFull, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
                    CoachAction("Ask new", onClick = {
                        onNewDraft(thread.lastOrNull()?.takeIf { it.answer == null && !it.pending }?.question.orEmpty())
                    })
                }
                else -> Composer(seed, asking, onAsk)
            }
        }
      }
    }
}

@Composable
private fun Head(onNotes: (() -> Unit)?) {
    val skin = LocalGymColors.current
    if (onNotes == null) return
    Column(Modifier.padding(horizontal = 20.dp)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp)
                .clickable(role = Role.Button, onClick = onNotes).padding(vertical = 12.dp),
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Notes", style = WindmillFont.body(16, FontWeight.Bold).copy(lineHeight = 22.sp), color = skin.ink)
                Text("What Coach should know", style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
            }
            Chevron()
        }
        Box(Modifier.fillMaxWidth().heightIn(min = 1.dp).background(skin.line))
    }
}

@Composable
fun AskSignedOutStance(seat: String, onSignIn: () -> Unit) {
    val skin = LocalGymColors.current
    GymScreen(title = Ask.title, actions = { YouSeat(seat) }) {
        Column(Modifier.fillMaxSize()) {
            Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp)) {
                Text(Ask.signedOut, style = WindmillFont.body(26, FontWeight.Bold).copy(lineHeight = 36.sp), color = skin.ink)
            }
            CoachAction("Sign in", onSignIn, primary = true, modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp))
        }
    }
}

// A bare 404 means the feature is not configured, so there is nothing to retry.
@Composable
fun AskAbsentStance(seat: String, onNotes: (() -> Unit)? = null, onConnections: (() -> Unit)? = null) {
    val skin = LocalGymColors.current
    GymScreen(title = Ask.title, actions = { YouSeat(seat) }) {
        Column(
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
            modifier = Modifier.fillMaxSize(),
        ) {
            Head(onNotes = onNotes)
            Text(
                Ask.notHere,
                style = WindmillFont.body(15).copy(lineHeight = 23.sp),
                color = skin.inkDim,
                modifier = Modifier.padding(horizontal = GymLayout.gutter),
            )
            onConnections?.let { CoachAction("Connected log", it, modifier = Modifier.padding(horizontal = 20.dp)) }
        }
    }
}

@Composable
private fun Opening(origin: String, onConnections: (() -> Unit)?) {
    val skin = LocalGymColors.current
    Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Nothing asked yet", style = WindmillFont.body(28, FontWeight.Bold).copy(lineHeight = 39.sp), color = skin.ink)
            Text("Ask about your training.", style = WindmillFont.body(18).copy(lineHeight = 25.sp), color = skin.inkDim)
        }
        ConnectDoor(origin, onConnections)
    }
}

@Composable
private fun ConnectDoor(origin: String, onConnections: (() -> Unit)?, label: String = "Connected log") {
    val skin = LocalGymColors.current
    val web = LocalUriHandler.current
    val telemetry = LocalTelemetry.current
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp).clickable(role = Role.Button) {
            if (onConnections != null) onConnections() else runCatching { web.openUri(ConnectedLog.setupUrl(origin)) }
                .onFailure { telemetry.failure("gym.openConnections", it) }
        }.padding(vertical = 12.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(label, style = WindmillFont.body(16, FontWeight.Bold).copy(lineHeight = 22.sp), color = skin.ink)
            Text("Use your own AI tool", style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
        }
        Chevron()
    }
}

@Composable
private fun CapDoors(cap: AskCap, origin: String, onAskNew: () -> Unit, onConnections: (() -> Unit)?) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
        if (cap == AskCap.Ceiling) ConnectDoor(origin, onConnections, "Connect own agent")
        CoachAction(Threads.open, onAskNew)
        if (cap == AskCap.Daily) ConnectDoor(origin, onConnections, "Connect own agent")
    }
}

@Composable
private fun Answer(
    answer: AskAnswer,
    minted: Map<String, Proposal>,
    catalog: List<Exercise>,
    nowMs: Long,
    lookedAt: Set<String>,
    onReview: (Proposal) -> Unit,
) {
    val skin = LocalGymColors.current
    Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3)) {
        CoachAnswer(answer.answer, answer.receipt, catalog, nowMs, answer.read, answer.steps)
        // Drawn from the LOG's own copy and never from what the model said about it.
        answer.proposals.mapNotNull { minted[it] }.forEach { proposal ->
            Minted(proposal, catalog, nowMs, stillWaiting = proposal.id in lookedAt) { onReview(proposal) }
        }
    }
}

// What the server said it did, the moment it said so. Not stored: reopening the thread does not
// draw it again, and nothing here pretends otherwise.
@Composable
fun ReceiptLine(line: String) {
    val skin = LocalGymColors.current
    val applied = line.startsWith("Applied")
    Text(line, style = WindmillFont.body(16, FontWeight.Bold).copy(lineHeight = 22.sp),
        color = if (applied) skin.accent else skin.ink,
        modifier = Modifier.fillMaxWidth().then(if (applied) Modifier.background(skin.surface, RoundedCornerShape(20.dp)).padding(16.dp) else Modifier.padding(vertical = 8.dp)))
}

@Composable
private fun Minted(proposal: Proposal, catalog: List<Exercise>, nowMs: Long, stillWaiting: Boolean, onReview: () -> Unit) {
    val skin = LocalGymColors.current
    Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
        ProposalCard(proposal, proposal.routineName, nowMs, stillWaiting, onReview)
        if (proposal.isPending) Text(Ask.promise, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.inkDim)
        proposal.receipt?.let { ReceiptLine(it) }
    }
}

@Composable
private fun Trouble(said: String, onRetry: (() -> Unit)?) {
    val skin = LocalGymColors.current
    Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
        Text(
            said,
            style = WindmillFont.body(14).copy(lineHeight = 21.sp),
            color = skin.inkDim,
        )
        onRetry?.let { retry ->
            Box(
                Modifier.heightIn(min = GymTap.minimum).clickable(role = Role.Button, onClick = retry),
                contentAlignment = Alignment.CenterStart,
            ) {
                Text("Try again", style = WindmillFont.body(14, FontWeight.SemiBold), color = skin.accent)
            }
        }
    }
}

@Composable
private fun Composer(seed: String, asking: Boolean, onAsk: (String) -> Unit) {
    val skin = LocalGymColors.current
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    var typed by rememberSaveable { mutableStateOf(seed) }
    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.Bottom,
        modifier = Modifier.fillMaxWidth().background(skin.surface, RoundedCornerShape(28.dp)).padding(8.dp),
    ) {
        BasicTextField(
            value = typed,
            onValueChange = { typed = it },
            textStyle = WindmillFont.body(16).copy(lineHeight = 22.sp, color = skin.ink),
            enabled = !asking,
            cursorBrush = androidx.compose.ui.graphics.SolidColor(skin.accent),
            decorationBox = { input ->
                Box(Modifier.heightIn(min = 48.dp).padding(start = 8.dp, top = 12.dp, bottom = 12.dp), contentAlignment = Alignment.CenterStart) {
                    if (typed.isEmpty()) Text(Ask.placeholder, style = WindmillFont.body(16).copy(lineHeight = 22.sp), color = skin.inkDim)
                    input()
                }
            },
            modifier = Modifier.weight(1f).semantics { contentDescription = "Question" },
        )
        val ready = Ask.sendable(typed) && !asking
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier.size(48.dp).clip(CircleShape).background(skin.raised)
                .semantics { contentDescription = "Send" }
                .clickable(enabled = ready, role = Role.Button) {
                    focus.clearFocus()
                    keyboard?.hide()
                    onAsk(typed.trim())
                    typed = ""
                },
        ) {
            Text("↑", style = WindmillFont.body(28), color = if (ready) skin.ink else skin.inkFaint)
        }
    }
}

// A real ceiling: a `rememberSaveable` rides in the Bundle crossing to the system, and past the
// process-wide cap the app dies with TransactionTooLargeException.
private const val savedThreadBytes = 32_000

// The live thread through an activity recreation, as JSON: the TAIL that fits, and a failed save or
// restore is EMPTY rather than a crash.
fun askThreadSaver(telemetry: Telemetry): Saver<List<AskExchange>, String> =
    Saver(save = { savedThread(it, telemetry) }, restore = { readThread(it, telemetry) })

internal fun savedThread(thread: List<AskExchange>, telemetry: Telemetry = Telemetry.None): String? = runCatching {
    var kept = thread
    var written = WindmillJson.encodeToString(ListSerializer(AskExchange.serializer()), kept)
    while (kept.size > 1 && written.toByteArray(Charsets.UTF_8).size > savedThreadBytes) {
        kept = kept.drop(1)
        written = WindmillJson.encodeToString(ListSerializer(AskExchange.serializer()), kept)
    }
    written
}.onFailure { telemetry.failure("gym.saveConversation", it) }.getOrNull()

internal fun readThread(written: String, telemetry: Telemetry = Telemetry.None): List<AskExchange> = runCatching {
    WindmillJson.decodeFromString(ListSerializer(AskExchange.serializer()), written)
}.onFailure { telemetry.failure("gym.restoreConversation", it) }.getOrDefault(emptyList())
