package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.serialization.builtins.ListSerializer
import works.windmill.gym.domain.Ask
import works.windmill.gym.domain.AskAnswer
import works.windmill.gym.domain.AskCap
import works.windmill.gym.domain.AskExchange
import works.windmill.gym.domain.ConnectedLog
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Threads
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
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
) {
    val nowMs = System.currentTimeMillis()
    val scroll = rememberScrollState()

    // Read back off the log: the reply carries ids only. A proposal moves when anybody decides, and a
    // decision taken in this room overrides the copy read here, so the card and the receipt agree.
    val minted = remember { mutableStateMapOf<String, Proposal>() }
    val wanted = thread.flatMap { it.answer?.proposals.orEmpty() }
    LaunchedEffect(wanted) {
        wanted.forEach { id ->
            if (minted.containsKey(id)) return@forEach
            val read = store.proposal(id)
            if (read is GymResult.Ok) minted[id] = read.value
        }
    }

    LaunchedEffect(thread, receipts) {
        withFrameNanos { }
        scroll.animateScrollTo(scroll.maxValue)
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
        Column(
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(scroll)
                .padding(horizontal = WindmillSpace.x4)
                .padding(top = WindmillSpace.x4, bottom = WindmillSpace.x2),
        ) {
            if (thread.isEmpty()) Opening(origin)
            thread.forEachIndexed { index, exchange ->
                Question(exchange.question)
                if (exchange.pending) {
                    Text(Ask.waiting, style = GymType.numeral(12), color = GymSkin.inkFaint)
                }
                exchange.answer?.let { answered ->
                    Answer(answered, minted + store.settledProposals, store.catalog, nowMs, lookedAt, onReview)
                }
                exchange.trouble?.let { said ->
                    // The cap-reached state says this refusal once, at the end of the thread just
                    // below; it is not drawn twice.
                    if (cap != null && index == thread.lastIndex) return@let
                    Trouble(
                        said = said,
                        // Only the NEWEST question may be asked again.
                        onRetry = onRetry.takeIf {
                            exchange.again && !asking && index == thread.lastIndex
                        },
                    )
                }
            }
            receipts.forEach { ReceiptLine(it) }
            // The moment the allowance ran out, at the end of the conversation it stopped. It reads
            // INSIDE the scroller, because the block below does not scroll and anything pinned there
            // comes off the thread: with this sentence scrolling, the thread keeps 283.5dp at
            // fontScale 2.0 — measured in `LargestTypeTests`, the one file in this suite with real
            // font metrics.
            cap?.let {
                Text(
                    thread.lastOrNull()?.trouble ?: it.wordless,
                    style = WindmillFont.body(15).copy(lineHeight = 22.sp),
                    color = GymSkin.ink,
                )
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
                .padding(horizontal = WindmillSpace.x4)
                .padding(top = WindmillSpace.x2, bottom = WindmillSpace.x3),
        ) {
            if (cap == null && thread.isEmpty()) Openers(asking, onAsk)
            if (cap != AskCap.Ceiling) {
                Text(Ask.allowance, style = GymType.numeral(12), color = GymSkin.inkFaint)
            }
            if (cap == null) Composer(seed, asking, onAsk) else CapDoors(cap, origin, onAskNew)
        }
      }
    }
}

// The notes door is a ROW under the terms, never a second action beside Threads: an icon up there
// would say Coach owns the notes, which is the opposite of what the notes screen exists to say.
@Composable
private fun Head(onNotes: (() -> Unit)?) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier.padding(bottom = WindmillSpace.x3),
    ) {
        // No line cap: at the largest font scale the terms wrap rather than losing their second
        // half, which is the half that says what Coach cannot do.
        Text(
            Ask.subtitle,
            style = GymType.numeral(12),
            color = GymSkin.inkFaint,
            modifier = Modifier.padding(horizontal = WindmillSpace.x4),
        )
        onNotes?.let { open ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = WindmillSpace.x4)
                    .heightIn(min = GymTap.minimum)
                    .clip(RoundedCornerShape(WindmillRadius.md))
                    .background(GymSkin.surface)
                    .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.md))
                    .clickable(role = Role.Button, onClick = open)
                    .padding(horizontal = WindmillSpace.x3),
            ) {
                Text(Ask.notesDoor, style = WindmillFont.body(14, FontWeight.SemiBold), color = GymSkin.ink)
                Spacer(Modifier.weight(1f))
                Chevron()
            }
        }
    }
}

@Composable
fun AskSignedOutStance(seat: String, onSignIn: () -> Unit) {
    GymScreen(title = Ask.title, actions = { YouSeat(seat) }) {
      Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
        modifier = Modifier.fillMaxSize(),
      ) {
        Head(onNotes = null)
        Column(
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
            modifier = Modifier.padding(horizontal = WindmillSpace.x4),
        ) {
            Text(
                Ask.whatItIs,
                style = WindmillFont.body(15).copy(lineHeight = 23.sp),
                color = GymSkin.inkDim,
            )
            Text(
                Ask.signedOut,
                style = WindmillFont.body(14).copy(lineHeight = 21.sp),
                color = GymSkin.inkFaint,
            )
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.primary - 8.dp)
                    .background(GymSkin.accent, RoundedCornerShape(WindmillRadius.lg))
                    .clickable(role = Role.Button, onClick = onSignIn),
            ) {
                Text("Sign in", style = WindmillFont.body(16, FontWeight.Bold), color = GymSkin.onAccent)
            }
        }
      }
    }
}

// A bare 404 means the feature is not configured, so there is nothing to retry.
@Composable
fun AskAbsentStance(seat: String) {
    GymScreen(title = Ask.title, actions = { YouSeat(seat) }) {
        Column(
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
            modifier = Modifier.fillMaxSize(),
        ) {
            Head(onNotes = null)
            Text(
                Ask.notHere,
                style = WindmillFont.body(15).copy(lineHeight = 23.sp),
                color = GymSkin.inkDim,
                modifier = Modifier.padding(horizontal = WindmillSpace.x4),
            )
        }
    }
}

@Composable
private fun Opening(origin: String) {
    Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4)) {
        Text(
            Ask.whatItIs,
            style = WindmillFont.body(15).copy(lineHeight = 23.sp),
            color = GymSkin.inkDim,
        )
        ConnectDoor(origin)
        Text(
            Ask.kept,
            style = GymType.numeral(12).copy(lineHeight = 18.sp),
            color = GymSkin.inkFaint,
        )
    }
}

// The one path that is not rationed: the empty room offers it, and so does the room with its
// allowance spent.
@Composable
private fun ConnectDoor(origin: String) {
    val web = LocalUriHandler.current
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier
            .fillMaxWidth()
            .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.lg))
            .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.lg))
            .padding(WindmillSpace.x4),
    ) {
        Text(
            Ask.freeDoor,
            style = WindmillFont.body(14).copy(lineHeight = 22.sp),
            color = GymSkin.inkFaint,
        )
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.minimum)
                .clip(RoundedCornerShape(WindmillRadius.md))
                .border(1.dp, GymSkin.lineStrong, RoundedCornerShape(WindmillRadius.md))
                .clickable(role = Role.Button) {
                    runCatching { web.openUri(ConnectedLog.setupUrl(origin)) }
                },
        ) {
            Text(Ask.connect, style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.accent)
        }
    }
}

// Where the composer stood: what to do next, not the rule again. There is no clock — the state stands
// for the rest of this visit. The sentence itself reads at the end of the thread, above; only the
// doors are pinned here, where a thumb is.
//
// Under the day's ten a new conversation is the way back to the composer, so it leads. Under the
// 30-day ceiling it is not: the fresh conversation cannot take a question either, so the connect
// door — the path neither ceiling rations — leads instead and the new conversation sits below it as
// a way out of this one.
@Composable
private fun CapDoors(cap: AskCap, origin: String, onAskNew: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3), modifier = Modifier.fillMaxWidth()) {
        if (cap == AskCap.Ceiling) ConnectDoor(origin)
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.minimum)
                .clip(RoundedCornerShape(WindmillRadius.md))
                .border(1.dp, GymSkin.lineStrong, RoundedCornerShape(WindmillRadius.md))
                .clickable(role = Role.Button, onClick = onAskNew),
        ) {
            Text(Threads.open, style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.accent)
        }
        if (cap == AskCap.Daily) ConnectDoor(origin)
    }
}

@Composable
private fun Question(question: String) {
    val bubble = RoundedCornerShape(17.dp, 17.dp, 6.dp, 17.dp)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Spacer(Modifier.weight(0.2f))
        Text(
            question,
            style = WindmillFont.body(15).copy(lineHeight = 22.sp),
            color = GymSkin.ink,
            modifier = Modifier
                .weight(0.8f, fill = false)
                .background(GymSkin.accentSoft, bubble)
                .border(1.dp, GymSkin.accent, bubble)
                .padding(horizontal = WindmillSpace.x3 + 2.dp, vertical = WindmillSpace.x3),
        )
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
    Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3)) {
        Text(
            answer.answer,
            style = WindmillFont.body(15).copy(lineHeight = 23.sp),
            color = GymSkin.ink,
        )
        // Drawn from the LOG's own copy and never from what the model said about it.
        answer.proposals.mapNotNull { minted[it] }.forEach { proposal ->
            Minted(proposal, catalog, nowMs, stillWaiting = proposal.id in lookedAt) { onReview(proposal) }
        }
        Receipt(answer)
    }
}

// What the server said it did, the moment it said so. Not stored: reopening the thread does not
// draw it again, and nothing here pretends otherwise.
@Composable
fun ReceiptLine(line: String) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier.fillMaxWidth().heightIn(min = GymTap.minimum),
    ) {
        Box(Modifier.size(6.dp).clip(CircleShape).background(GymSkin.setDone))
        Text(line, style = GymType.numeral(12, FontWeight.Bold), color = GymSkin.inkDim)
    }
}

// The receipt is always visible: it is how a lifter knows what the answer stands on. The steps sit
// behind it, in the lifter's words, and open on one tap; a step this build cannot name is not drawn.
@Composable
private fun Receipt(answer: AskAnswer) {
    val phrases = Ask.steps(answer.steps)
    var open by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
            modifier = Modifier
                .heightIn(min = if (phrases.isEmpty()) 0.dp else GymTap.minimum)
                .then(
                    if (phrases.isEmpty()) Modifier
                    else Modifier
                        .semantics { stateDescription = if (open) "expanded" else "collapsed" }
                        .clickable(role = Role.Button) { open = !open },
                ),
        ) {
            Text(Ask.receipt(answer.read), style = GymType.numeral(11), color = GymSkin.inkFaint)
            if (phrases.isNotEmpty()) {
                Icon(
                    if (open) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                    contentDescription = null,
                    tint = GymSkin.inkFaint,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
        if (open) {
            Column(
                verticalArrangement = Arrangement.spacedBy(5.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.md))
                    .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.md))
                    .padding(WindmillSpace.x3),
            ) {
                phrases.forEach { phrase ->
                    Text(phrase, style = GymType.numeral(12), color = GymSkin.inkDim)
                }
            }
        }
    }
}

@Composable
private fun Minted(
    proposal: Proposal,
    catalog: List<Exercise>,
    nowMs: Long,
    stillWaiting: Boolean,
    onReview: () -> Unit,
) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier
            .fillMaxWidth()
            .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.lg))
            .border(1.dp, GymSkin.accent, RoundedCornerShape(WindmillRadius.lg))
            .padding(WindmillSpace.x4),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Box(Modifier.size(6.dp).clip(CircleShape).background(GymSkin.accent))
            Spacer(Modifier.size(WindmillSpace.x2))
            Text(
                "Proposal · ${proposal.routineName}",
                style = GymType.numeral(11, FontWeight.Bold),
                color = GymSkin.accent,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
            proposal.drawn.take(3).forEach { change ->
                Row(horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
                    Text(
                        Readout.movement(change.exerciseId, catalog),
                        style = GymType.numeral(12),
                        color = GymSkin.inkFaint,
                        maxLines = 1,
                        modifier = Modifier.width(96.dp),
                    )
                    Text(change.compactLine, style = GymType.numeral(12), color = GymSkin.inkDim)
                }
            }
            if (proposal.drawn.size > 3) {
                Text(
                    "+ ${proposal.drawn.size - 3} more",
                    style = GymType.numeral(11),
                    color = GymSkin.inkFaint,
                )
            }
        }
        Text(
            if (proposal.isPending) proposal.cardLine(proposal.routineName, stillWaiting)
            else proposal.historyLine(nowMs),
            style = GymType.numeral(11),
            color = GymSkin.inkFaint,
        )
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.minimum)
                .background(GymSkin.accent, RoundedCornerShape(WindmillRadius.md))
                .clickable(role = Role.Button, onClick = onReview),
        ) {
            Text(proposal.reviewLabel, style = WindmillFont.body(14, FontWeight.Bold), color = GymSkin.onAccent)
        }
        // A promise about what Apply will do is spent the moment Apply is taken or turned down: a
        // card that reads `applied` may not still say nothing has been.
        if (proposal.isPending) {
            Text(Ask.promise, style = GymType.numeral(11).copy(lineHeight = 17.sp), color = GymSkin.inkFaint)
        }
    }
}

@Composable
private fun Trouble(said: String, onRetry: (() -> Unit)?) {
    Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
        Text(
            said,
            style = WindmillFont.body(14).copy(lineHeight = 21.sp),
            color = GymSkin.inkDim,
        )
        onRetry?.let { retry ->
            Box(
                Modifier.heightIn(min = GymTap.minimum).clickable(role = Role.Button, onClick = retry),
                contentAlignment = Alignment.CenterStart,
            ) {
                Text("Try again", style = WindmillFont.body(14, FontWeight.SemiBold), color = GymSkin.accent)
            }
        }
    }
}

// The empty room's three openers: each is a question sent as tapped.
@Composable
private fun Openers(asking: Boolean, onAsk: (String) -> Unit) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier.horizontalScroll(rememberScrollState()),
    ) {
        Ask.openers.forEach { opener ->
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .heightIn(min = GymTap.minimum)
                    .clip(RoundedCornerShape(WindmillRadius.full))
                    .border(1.dp, GymSkin.lineStrong, RoundedCornerShape(WindmillRadius.full))
                    .clickable(enabled = !asking, role = Role.Button) { onAsk(opener) }
                    .padding(horizontal = WindmillSpace.x3),
            ) {
                Text(opener, style = WindmillFont.body(13, FontWeight.SemiBold), color = GymSkin.inkDim)
            }
        }
    }
}

// The input and the send control. The composer holds the wire's own ceiling, and the send door is
// shut on a blank question.
@Composable
private fun Composer(seed: String, asking: Boolean, onAsk: (String) -> Unit) {
    var typed by rememberSaveable { mutableStateOf(seed) }
    Row(
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth(),
    ) {
        OutlinedTextField(
            value = typed,
            onValueChange = { edited -> if (Ask.sendable(edited) || edited.isBlank()) typed = edited },
            textStyle = WindmillFont.body(16),
            enabled = !asking,
            placeholder = { Text(Ask.placeholder, style = WindmillFont.body(16)) },
            shape = RoundedCornerShape(WindmillRadius.lg),
            colors = gymFieldColours(),
            modifier = Modifier.weight(1f).heightIn(min = 54.dp),
        )
        val ready = Ask.sendable(typed) && !asking
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .size(54.dp)
                .background(
                    if (ready) GymSkin.accent else GymSkin.raised,
                    RoundedCornerShape(WindmillRadius.lg),
                )
                .clickable(enabled = ready, role = Role.Button) {
                    onAsk(typed.trim())
                    typed = ""
                },
        ) {
            Icon(
                Icons.AutoMirrored.Filled.Send,
                contentDescription = "Send",
                tint = if (ready) GymSkin.onAccent else GymSkin.inkFaint,
                modifier = Modifier.size(22.dp),
            )
        }
    }
}

// A real ceiling: a `rememberSaveable` rides in the Bundle crossing to the system, and past the
// process-wide cap the app dies with TransactionTooLargeException.
private const val savedThreadBytes = 32_000

// The live thread through an activity recreation, as JSON: the TAIL that fits, and a failed save or
// restore is EMPTY rather than a crash.
val askThreadSaver: Saver<List<AskExchange>, String> =
    Saver(save = { savedThread(it) }, restore = { readThread(it) })

internal fun savedThread(thread: List<AskExchange>): String? = runCatching {
    var kept = thread
    var written = WindmillJson.encodeToString(ListSerializer(AskExchange.serializer()), kept)
    while (kept.size > 1 && written.toByteArray(Charsets.UTF_8).size > savedThreadBytes) {
        kept = kept.drop(1)
        written = WindmillJson.encodeToString(ListSerializer(AskExchange.serializer()), kept)
    }
    written
}.getOrNull()

internal fun readThread(written: String): List<AskExchange> = runCatching {
    WindmillJson.decodeFromString(ListSerializer(AskExchange.serializer()), written)
}.getOrDefault(emptyList())
