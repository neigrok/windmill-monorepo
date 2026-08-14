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
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.serialization.builtins.ListSerializer
import works.windmill.gym.domain.Ask
import works.windmill.gym.domain.AskAnswer
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

// ASK (§L, screens 26 and 27) — a chat, because not everyone brings their own agent. It reads the
// log and it proposes; it cannot edit or delete a logged set, and that is STRUCTURAL rather than a
// promise made in a prompt: `AskTools` on the server wraps the same catalog the MCP door speaks and
// hands the model the reads plus the two tools that mint a proposal — filtered when the tools are
// listed AND checked again when one is called, so a name the model invents is refused at the call.
// (The token itself carries gym's three levels; what narrows Ask is that wrapper, and naming the
// token here would point a future reader at the wrong line.)
//
// EVERY ANSWER NAMES ITS READ, and the number is the SERVER'S: it was counted as the rows were
// handed over, deduped by id, and it arrives in the reply. Nothing on this screen adds up, infers or
// re-derives it — a receipt a client could compose is a receipt a model could invent, and then the
// one line that makes a claim checkable would be the least trustworthy thing on the page.
//
// IT DOES NOT SPEAK FIRST. The empty state is chrome — what Ask is, and the free door that is better
// than it — and it is not drawn as a message from anybody. There is no personality here, no
// encouragement, no "great job", no check-in, no streak and no badge; the only chips are three
// openers, and nothing counts whether they were tapped.
//
// NO PRICE, NO UPGRADE, NO LOCK. Ask ships open to everyone with a daily cap, because Windmill One
// cannot be bought — a locked chat offering a purchase would advertise a checkout that answers 503.
// THE CAP IS STATED WHERE ASK IS EXPLAINED (`Ask.dailyCap`, in the opening chrome) and not only in
// the refusal that meets it: this is the first thing in the product with a cost per use, so the
// ration is a fact a lifter reads before they run out. When it is reached the server's own sentence
// is drawn, in the same words, with nothing sold against it.
//
// WHAT §L DRAWS AND THIS DOES NOT, both for the same reason — the wire does not carry it, and this
// room does not draw what it cannot stand behind:
//   · THE TRAINING ROWS UNDER AN ANSWER. The reply carries the COUNT of what was served and not the
//     rows themselves, and rows a client re-queried or a model summarised are not the rows it
//     reasoned from — a second account of the same answer is exactly what a server-observed receipt
//     exists to rule out. What the wire does carry is which tools were called, so that is drawn, in
//     their own MCP names; the rows arrive the wave the server hands them over.
//   · THE REFUSAL CARD naming the exact set with an `Open ›` into the fix path. A refusal comes back
//     as prose and nothing beside it identifies a session or a set, so a card would be this room
//     reading English to guess which row a lifter meant.
//   · THE `One` CHIP in the header, which would advertise a plan this feature does not gate on.
//
// THE QUESTION IS NOT THIS SCREEN'S TO OWN. It is asked by the ROOM, where the thread lives, for one
// reason: the day's questions are counted at the edge the moment the request lands, so a lifter who
// walks to home mid-answer has already paid for an answer this screen's own coroutine would have
// thrown away — and a proposal it minted would sit unread until the next connect. Asked from the
// room, the answer lands in the thread whether or not anybody is looking at it.
@Composable
fun AskScreen(
    store: TrainingStore,
    thread: List<AskExchange>,
    asking: Boolean,
    onAsk: (String) -> Unit,
    onRetry: () -> Unit,
    seed: String,
    origin: String,
    // Null when this surface is the ASK TAB'S ROOT (R7): the rail under it is the way to somewhere
    // else, so there is no back bar to draw. Both set when it was pushed from a proposal, where the
    // way back names the diff it returns to.
    backLabel: String?,
    onBack: (() -> Unit)?,
    onThreads: () -> Unit,
    onReview: (Proposal) -> Unit,
) {
    val nowMs = System.currentTimeMillis()
    val scroll = rememberScrollState()

    // THE PROPOSALS THIS CONVERSATION MINTED, READ BACK OFF THE LOG. The reply carries ids; the
    // object is the log's, so the card is drawn from a read and never from the answer's prose. It is
    // deliberately NOT saved with the thread: a proposal moves the moment anybody decides anything,
    // and a card restored from a Bundle would offer a review of a diff that may already be applied.
    val minted = remember { mutableStateMapOf<String, Proposal>() }
    val wanted = thread.flatMap { it.answer?.proposals.orEmpty() }
    LaunchedEffect(wanted) {
        wanted.forEach { id ->
            if (minted.containsKey(id)) return@forEach
            val read = store.proposal(id)
            if (read is GymResult.Ok) minted[id] = read.value
        }
    }

    // The foot of the thread after every change, once the new rows have measured — a chat that
    // answered above the fold would make the lifter scroll to find out what they were told.
    LaunchedEffect(thread) {
        withFrameNanos { }
        scroll.animateScrollTo(scroll.maxValue)
    }

    Column(
        Modifier
            .fillMaxSize()
            .imePadding(),
    ) {
        Head(backLabel, onBack, onThreads)
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
                // What is happening, rather than a spinner about it: Ask's first move on every
                // question is to go and read the log, and saying so is both truer and quieter.
                if (exchange.pending) {
                    Text(Ask.waiting, style = GymType.numeral(12), color = GymSkin.inkFaint)
                }
                exchange.answer?.let { answered ->
                    Answer(answered, minted, store.catalog, nowMs, onReview)
                }
                exchange.trouble?.let { said ->
                    Trouble(
                        said = said,
                        // Only a log that went quiet is worth another tap — a cap, a thread the
                        // server could not read and a workout still open are answers, and a Retry
                        // under one of those would be an offer that is not one. And only the NEWEST
                        // question can be asked again: a retry further up would have to send the
                        // thread as it stood then, which means dropping what the lifter has asked
                        // since, and no button in this room deletes something a lifter typed.
                        onRetry = onRetry.takeIf {
                            exchange.again && !asking && index == thread.lastIndex
                        },
                    )
                }
            }
        }
        Composer(
            seed = seed,
            openers = if (thread.isEmpty()) Ask.openers else emptyList(),
            asking = asking,
            onAsk = onAsk,
        )
    }
}

// The way back where there is one — the tab root has none, and draws the rail's own hairline of
// air instead — and then what this screen is. NO CHIP BESIDE IT: §L draws a `One` badge there, and
// this feature is gated on nothing, so a badge for a plan that cannot be bought would be an advert
// standing where the design wanted a fact. The subtitle is the fact: it reads your log, and it
// proposes only.
//
// THE ONE THING TO THE RIGHT IS §O'S DOOR onto the conversations before this one, and it is a WORD
// rather than a count: a number there would be an inbox growing out of a header, and there is
// nothing here waiting for anybody. It says how many conversations there are on the screen it opens,
// once the log has actually said.
@Composable
private fun Head(backLabel: String?, onBack: (() -> Unit)?, onThreads: (() -> Unit)?) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier
            .padding(bottom = WindmillSpace.x3)
            // The tab root has no back row, so the title takes its breathing room instead.
            .padding(top = if (backLabel == null) WindmillSpace.x3 else 0.dp),
    ) {
        if (backLabel != null && onBack != null) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
                modifier = Modifier
                    .heightIn(min = GymTap.minimum)
                    .padding(horizontal = WindmillSpace.x4)
                    .clickable(onClick = onBack),
            ) {
                Text("‹", style = WindmillFont.body(19, FontWeight.SemiBold), color = GymSkin.inkDim)
                Text(backLabel, style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.inkDim)
            }
        }
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth().padding(horizontal = WindmillSpace.x4),
        ) {
            Column(
                verticalArrangement = Arrangement.spacedBy(1.dp),
                modifier = Modifier.weight(1f),
            ) {
                Text(Ask.title, style = WindmillFont.display(26), color = GymSkin.ink, maxLines = 1)
                Text(Ask.subtitle, style = GymType.numeral(12), color = GymSkin.inkFaint, maxLines = 1)
            }
            onThreads?.let { open ->
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .heightIn(min = GymTap.minimum)
                        .clip(RoundedCornerShape(WindmillRadius.full))
                        .clickable(onClick = open)
                        .padding(horizontal = WindmillSpace.x3),
                ) {
                    Text(
                        Threads.door,
                        style = WindmillFont.body(14, FontWeight.SemiBold),
                        color = GymSkin.accent,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

// THE TAB'S SIGNED-OUT STANCE (decisions §3 / R7). A tab cannot be absent the way a door could be,
// and a 401 is not a screen — so what stands here is what Ask is, in the product's own locked
// words, and the one step between the lifter and an answer. The tab-root form is undrawn on the
// boards (filed as a design ask), so this is the minimal faithful stance: no pitch, no lock, no
// count of how many times it was read and walked past.
@Composable
fun AskSignedOutStance(onSignIn: () -> Unit) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
        modifier = Modifier.fillMaxSize(),
    ) {
        Head(backLabel = null, onBack = null, onThreads = null)
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
                "Ask reads your account’s log, so it needs you signed in before it has anything to read.",
                style = WindmillFont.body(14).copy(lineHeight = 21.sp),
                color = GymSkin.inkFaint,
            )
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.primary - 8.dp)
                    .background(GymSkin.accent, RoundedCornerShape(WindmillRadius.lg))
                    .clickable(onClick = onSignIn),
            ) {
                Text("Sign in", style = WindmillFont.body(16, FontWeight.Bold), color = GymSkin.onAccent)
            }
            Text(
                Ask.dailyCap,
                style = GymType.numeral(12).copy(lineHeight = 18.sp),
                color = GymSkin.inkFaint,
            )
        }
    }
}

// THE TAB'S ABSENT STANCE: this deployment answered Ask's route with the bare 404 that means the
// feature is not configured — not that something failed — so the tab says so quietly, once, and
// offers nothing to retry. The lifter's log is untouched by any of it and the sentence says so.
@Composable
fun AskAbsentStance() {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
        modifier = Modifier.fillMaxSize(),
    ) {
        Head(backLabel = null, onBack = null, onThreads = null)
        Text(
            Ask.notHere,
            style = WindmillFont.body(15).copy(lineHeight = 23.sp),
            color = GymSkin.inkDim,
            modifier = Modifier.padding(horizontal = WindmillSpace.x4),
        )
    }
}

// WHAT ASK IS, BEFORE IT HAS SAID ANYTHING — and it is not a message: this screen does not speak
// first, so the empty state is chrome in the room's own voice rather than a greeting from a
// character. The free door is here because an in-app chat that tells you how to stop paying us
// costs one paragraph and is the strongest proof the connected log is real.
//
// THE CAP IS SAID HERE, in the same breath as the offer and in the server's own numbers. A limit a
// lifter can only meet as a refusal is a limit that was hidden, and this one is a design decision
// rather than an ops detail — it is what lets Ask be open to everybody in a product with nothing to
// buy. It is the last thing under the offer rather than the first thing over it, because what Ask
// does is the reason somebody is reading and how much of it they get is the condition on that.
@Composable
private fun Opening(origin: String) {
    // The grant is a web page, so the offer opens one. Told to fail QUIETLY: a phone with no browser
    // at all is the only way this misses, and the sentence above it is still true and still the
    // point — a crashed room would be a worse answer than a tap that did nothing.
    val web = LocalUriHandler.current
    Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4)) {
        Text(
            Ask.whatItIs,
            style = WindmillFont.body(15).copy(lineHeight = 23.sp),
            color = GymSkin.inkDim,
        )
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
                    .clickable { runCatching { web.openUri(ConnectedLog.setupUrl(origin)) } },
            ) {
                Text(Ask.connect, style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.accent)
            }
        }
        Text(
            Ask.dailyCap,
            style = GymType.numeral(12).copy(lineHeight = 18.sp),
            color = GymSkin.inkFaint,
        )
        // What becomes of what you ask, in the same quiet ink as the cap: the log keeps it, and the
        // list at the head of this screen is where you delete it.
        Text(
            Ask.kept,
            style = GymType.numeral(12).copy(lineHeight = 18.sp),
            color = GymSkin.inkFaint,
        )
    }
}

// The lifter's own words, kept on screen whatever came back — a bubble that vanished with its
// failure would take the question with it.
@Composable
private fun Question(question: String) {
    val bubble = RoundedCornerShape(17.dp, 17.dp, 6.dp, 17.dp)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        // Right up to four fifths of the line and no further, and SHORTER when the question is —
        // `fill = false` is what keeps a three-word question from being drawn as a wide box with a
        // few letters in the corner of it.
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

// THE ANSWER, AND THE EVIDENCE UNDER IT — in that order, because the claim comes first and what is
// beneath it is what makes the claim checkable without trusting it. The prose is drawn as it arrived
// (no markdown, no headings, nothing parsed), then what the answer was steered by, then the server's
// own count of what it served.
@Composable
private fun Answer(
    answer: AskAnswer,
    minted: Map<String, Proposal>,
    catalog: List<Exercise>,
    nowMs: Long,
    onReview: (Proposal) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3)) {
        Text(
            answer.answer,
            style = WindmillFont.body(15).copy(lineHeight = 23.sp),
            color = GymSkin.ink,
        )
        // WHICH TOOLS THE MODEL ASKED FOR, in call order and in their own MCP names — the names a
        // lifter's own Claude sees over the other door, because renaming them for the room would put
        // two vocabularies on one catalog. The opening read is not among them: Ask made it, not the
        // model, and printing it as a move would credit the model with a decision it never took.
        //
        // A step that failed is marked in WORDS and not in the alarm ink: this room paints that
        // colour on a write that failed and on nothing else, and a read the model can simply ask
        // for again is not a loss.
        if (answer.steps.isNotEmpty()) {
            Column(
                verticalArrangement = Arrangement.spacedBy(5.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.md))
                    .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.md))
                    .padding(WindmillSpace.x3),
            ) {
                answer.steps.forEach { step ->
                    Text(step.line, style = GymType.numeral(12), color = GymSkin.inkDim, maxLines = 1)
                }
            }
        }
        // A proposal minted mid-conversation, drawn from the LOG's own copy of it rather than from
        // anything the model said about it. One that has not been read back yet draws nothing here —
        // and is not lost: the card is waiting on home and on the routine it touches, because the
        // store re-reads the program the moment an answer mints one.
        answer.proposals.mapNotNull { minted[it] }.forEach { proposal ->
            Minted(proposal, catalog, nowMs) { onReview(proposal) }
        }
        // NEVER COMPUTED HERE. The three counts are the server's, deduped where the ids are, and
        // this line only spells them — which is the whole reason a lifter can check a claim against
        // it instead of taking the model's word for the reading.
        Text(Ask.receipt(answer.read), style = GymType.numeral(11), color = GymSkin.inkFaint)
    }
}

// SCREEN 27'S CARD — what a proposal minted in this conversation looks like inside it: whose it is,
// what it would do in the routine's own grammar, and the one door onto the diff where the tap
// happens. Three rows at most, because this is a summons to the decision and not the decision.
//
// It is the SAME OBJECT home and the routine's own page carry, drawn one size smaller here, and every
// word of it is the domain's: the counts, the labels and `ProposalChange.compactLine`, which is the
// diff screen's own grammar at card size. A screen that spelled its own diff — or rounded its own
// load — would be the second place in this product describing one change.
@Composable
private fun Minted(
    proposal: Proposal,
    catalog: List<Exercise>,
    nowMs: Long,
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
            )
            Spacer(Modifier.weight(1f))
            Text(proposal.counted, style = GymType.numeral(11), color = GymSkin.inkFaint, maxLines = 1)
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
        // A proposal decided somewhere else since is not offered as a decision again: what happened
        // to it is said in its own dated words, and the door still opens the record.
        if (!proposal.isPending) {
            Text(proposal.historyLine(nowMs), style = GymType.numeral(11), color = GymSkin.inkFaint)
        }
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.minimum)
                .background(GymSkin.accent, RoundedCornerShape(WindmillRadius.md))
                .clickable(onClick = onReview),
        ) {
            Text(proposal.reviewLabel, style = WindmillFont.body(14, FontWeight.Bold), color = GymSkin.onAccent)
        }
        Text(Ask.promise, style = GymType.numeral(11).copy(lineHeight = 17.sp), color = GymSkin.inkFaint)
    }
}

// What the log said about a question it would not answer — in its own words, because the sentence is
// the server's copy and this room does not rewrite it. A cap is drawn exactly like a 502: quietly,
// with nothing sold against it and nothing to tap but a retry where one is honest.
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
                Modifier.heightIn(min = GymTap.minimum).clickable(onClick = retry),
                contentAlignment = Alignment.CenterStart,
            ) {
                Text("Try again", style = WindmillFont.body(14, FontWeight.SemiBold), color = GymSkin.accent)
            }
        }
    }
}

// THE COMPOSER, and the openers above it. The field holds the wire's own ceiling rather than finding
// out about it from a refusal: a question longer than the log takes simply cannot be typed past, so
// nobody loses what they wrote to a 400. The send door is shut on a blank one for the same reason —
// the round trip would only come back saying what the screen already knows.
@Composable
private fun Composer(
    seed: String,
    openers: List<String>,
    asking: Boolean,
    onAsk: (String) -> Unit,
) {
    // THE DRAFT IS THE COMPOSER'S OWN, and it is saveable for the reason the thread is: half a
    // question is still something somebody typed. It is SEEDED when the door came from a proposal —
    // a draft and never a send, so it is edited, cleared or ignored. An opener leaves it alone: a
    // chip is a question of its own and not a reason to throw away words already on screen.
    var typed by rememberSaveable { mutableStateOf(seed) }
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = WindmillSpace.x4)
            .padding(top = WindmillSpace.x2, bottom = WindmillSpace.x3),
    ) {
        if (openers.isNotEmpty()) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
                modifier = Modifier.horizontalScroll(rememberScrollState()),
            ) {
                openers.forEach { opener ->
                    Box(
                        contentAlignment = Alignment.Center,
                        modifier = Modifier
                            .heightIn(min = 38.dp)
                            .clip(RoundedCornerShape(WindmillRadius.full))
                            .border(1.dp, GymSkin.lineStrong, RoundedCornerShape(WindmillRadius.full))
                            .clickable(enabled = !asking) { onAsk(opener) }
                            .padding(horizontal = WindmillSpace.x3),
                    ) {
                        Text(opener, style = WindmillFont.body(13, FontWeight.SemiBold), color = GymSkin.inkDim)
                    }
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2), modifier = Modifier.fillMaxWidth()) {
            BasicTextField(
                value = typed,
                // Held at the ceiling rather than truncated at it: an edit that would take the
                // question past what the log accepts is refused, so the text on screen is always
                // the text that would be sent.
                onValueChange = { edited -> if (Ask.sendable(edited) || edited.isBlank()) typed = edited },
                textStyle = WindmillFont.body(16).copy(color = GymSkin.ink),
                cursorBrush = SolidColor(GymSkin.accent),
                enabled = !asking,
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = 54.dp)
                    .clip(RoundedCornerShape(WindmillRadius.lg))
                    .background(GymSkin.raised)
                    .border(1.dp, GymSkin.lineStrong, RoundedCornerShape(WindmillRadius.lg)),
                decorationBox = { inner ->
                    Box(
                        Modifier.fillMaxWidth().padding(horizontal = WindmillSpace.x4, vertical = WindmillSpace.x3),
                        contentAlignment = Alignment.CenterStart,
                    ) {
                        if (typed.isEmpty()) {
                            Text(Ask.placeholder, style = WindmillFont.body(16), color = GymSkin.inkFaint)
                        }
                        inner()
                    }
                },
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
                    .clickable(enabled = ready) {
                        onAsk(typed.trim())
                        typed = ""
                    },
            ) {
                Text(
                    "↑",
                    style = WindmillFont.body(20, FontWeight.Bold),
                    color = if (ready) GymSkin.onAccent else GymSkin.inkFaint,
                )
            }
        }
    }
}

// WHAT A SAVED CONVERSATION MAY WEIGH, and it is a real ceiling rather than a comfortable number.
// Everything a `rememberSaveable` holds rides in the Bundle that crosses to the system in
// `onSaveInstanceState`, and that transaction is capped for the whole process — go past it and the
// app is killed with a TransactionTooLargeException. NOTHING ELSE BOUNDS THIS ONE: the composer
// holds each QUESTION to the wire's ceiling, but an answer is server-sized and the number of
// exchanges is whatever a lifter asks in the life of one activity.
private const val savedThreadBytes = 32_000

// THE THREAD THROUGH AN ACTIVITY RECREATION, as JSON. The LOG keeps the turns now (§O), but it does
// not keep this: the receipt under each answer, the tools a question was steered by, and a question
// that failed with no reply at all are facts about one exchange as it happened, and none of them is
// on the threads read. So the live conversation still survives a recreation the way the open tab
// does — hoisted into the room and saved — and what the log holds is the past rather than the
// evening in progress.
//
// WHAT IS SAVED IS THE TAIL THAT FITS, and this is now the ONLY trim left anywhere in Ask: §O put
// the whole conversation on the log, so nothing is dropped on the wire and nothing is dropped from
// what a lifter can read back. A conversation past the ceiling above loses its OLDEST exchanges and
// never its newest, because a conversation is about where it has got to and the oldest of it is the
// half already stored. The trim happens on the way out and never to what is on screen, so
// nothing a lifter is looking at disappears while they look at it — a recreation is where the
// scrollback shortens, and the alternative is the recreation killing the app.
//
// A save or a restore that fails is EMPTY rather than a crash, exactly as every file this room reads
// off disk opens empty when it cannot be parsed: losing a conversation is a disappointment, and
// taking the room down with it is not a trade this product makes.
//
// The two halves are named rather than written inline for one reason: a restore is the one code path
// in this room a lifter can reach by rotating their phone and nobody would ever run by hand, so both
// are driven directly in AskThreadSaverTests — the ceiling included, which is not a thing anybody
// can eyeball on a device until the day it kills the app.
val askThreadSaver: Saver<List<AskExchange>, String> =
    Saver(save = { savedThread(it) }, restore = { readThread(it) })

internal fun savedThread(thread: List<AskExchange>): String? = runCatching {
    var kept = thread
    var written = WindmillJson.encodeToString(ListSerializer(AskExchange.serializer()), kept)
    // The newest exchange is kept whatever it weighs: a thread that saved nothing would answer a
    // rotation with an empty room, which is the loss this saver exists to prevent.
    while (kept.size > 1 && written.toByteArray(Charsets.UTF_8).size > savedThreadBytes) {
        kept = kept.drop(1)
        written = WindmillJson.encodeToString(ListSerializer(AskExchange.serializer()), kept)
    }
    written
}.getOrNull()

internal fun readThread(written: String): List<AskExchange> = runCatching {
    WindmillJson.decodeFromString(ListSerializer(AskExchange.serializer()), written)
}.getOrDefault(emptyList())
