package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.R
import works.windmill.gym.domain.Program
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.RoutineEntry
import works.windmill.gym.domain.RoutineEvent
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.WriteFailure
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// Planning stays in the top bar; Start logging stays within reach.
@Composable
fun RoutinesScreen(
    store: TrainingStore,
    isSignedIn: Boolean,
    // Reviews opened and closed with nothing decided: those cards read `still waiting`.
    lookedAt: Set<String>,
    seat: String,
    onJustStart: () -> Unit,
    onBuild: (RoutineDraft) -> Unit,
    onOpenRoutine: (String) -> Unit,
    onDeleteRoutine: (String) -> Unit,
    onReview: (Proposal) -> Unit,
    onSignIn: () -> Unit,
) {
    val skin = LocalGymColors.current
    val nowMs = System.currentTimeMillis()
    val routines = store.routines.sortedByDescending { it.lastTrainedAtMs ?: Long.MIN_VALUE }
    // The ROWS are the window's and the STANCE is the program's: an account holding one routine the
    // window has taken off the screen is not an account with no routines, and `Build a routine` is an
    // ACT offered over a program that still has one. Between the two the room draws neither.
    val empty = store.allRoutines.isEmpty()
    val standing = store.pendingProposals.firstOrNull()

    GymScreen(
        title = "Routines",
        actions = {
            TopAction("New routine") { onBuild(RoutineDraft(position = store.allRoutines.size)) }
            YouSeat(seat)
        },
    ) {
        Column(Modifier.fillMaxSize()) {
            LazyColumn(
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(
                    start = GymLayout.gutter,
                    end = GymLayout.gutter,
                    top = 16.dp,
                    bottom = GymLayout.scrollTailBand,
                ),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                if (routines.isNotEmpty()) {
                    item("count") {
                        Text(
                            Readout.routineCount(routines.size),
                            style = WindmillFont.body(14),
                            color = skin.inkDim,
                        )
                    }
                }

                item("refusals") {
                    Refusals(store.refusals, store.catalog, onDismiss = { store.clearRefusals() })
                }

                // The newest waiting card, one at a time; the others keep their dot on their
                // routine's row, and the routine this card is about draws no dot of its own.
                standing?.let { waiting ->
                    item("proposal") {
                        ProposalCard(
                            proposal = waiting,
                            routineName = store.routine(waiting.routineId)?.name ?: waiting.routineName,
                            nowMs = nowMs,
                            stillWaiting = waiting.id in lookedAt,
                            onReview = { onReview(waiting) },
                        )
                    }
                }

                if (!isSignedIn) item("claim") { ClaimCard(onSignIn) }

                if (empty) {
                    item("empty") {
                        Text("No routines yet.", style = WindmillFont.body(24, FontWeight.Bold), color = skin.ink,
                            modifier = Modifier.padding(top = 20.dp))
                    }
                } else {
                    items(routines, key = { it.id }) { routine ->
                        SwipeableRoutineRow(
                            routine = routine,
                            standingProposalId = standing?.id,
                            nowMs = nowMs,
                            onOpenRoutine = onOpenRoutine,
                            onDelete = { onDeleteRoutine(routine.id) },
                            onDuplicate = { onBuild(RoutineDraft.duplicate(routine, store.allRoutines.size)) },
                            onReview = onReview,
                        )
                    }
                }

            }

            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = WindmillSpace.x5)
                    .padding(top = 20.dp, bottom = 12.dp)
                    .heightIn(min = GymTap.primary)
                    .background(skin.accent, RoundedCornerShape(WindmillRadius.lg))
                    .clickable(role = Role.Button, onClick = onJustStart),
            ) {
                Text(
                    "Start logging",
                    style = WindmillFont.body(16, FontWeight.Bold),
                    color = skin.onAccent,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SwipeableRoutineRow(
    routine: Routine,
    standingProposalId: String?,
    nowMs: Long,
    onOpenRoutine: (String) -> Unit,
    onDelete: () -> Unit,
    onDuplicate: () -> Unit,
    onReview: (Proposal) -> Unit,
) {
    val haptics = rememberGymHaptics()
    // A leading swipe never settles here — and a row put back by a refusal or an Undo arrives with
    // no act owed, which is `rememberRowDismiss`'s whole reason to exist.
    val swipe = rememberRowDismiss(settling = { it == SwipeToDismissBoxValue.EndToStart }) {
        haptics.revealed()
        onDelete()
    }
    SwipeToDismissBox(
        state = swipe,
        enableDismissFromStartToEnd = false,
        backgroundContent = { RowDeleteGround() },
    ) {
        RoutineRow(routine, standingProposalId, nowMs, onOpenRoutine, onDelete, onDuplicate, onReview)
    }
}

// A routine with a proposal wears the accent border. The chip — a dot, a count and its own target
// onto the diff — is drawn on the routines the standing card is NOT about, so no proposal is
// rendered twice.
@Composable
private fun RoutineRow(
    routine: Routine,
    standingProposalId: String?,
    nowMs: Long,
    onOpenRoutine: (String) -> Unit,
    onDelete: () -> Unit,
    onDuplicate: () -> Unit,
    onReview: (Proposal) -> Unit,
) {
    val skin = LocalGymColors.current
    val waiting = routine.pendingProposal
    var menu by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().heightIn(min = 80.dp)
        .background(skin.canvas)
        .clickable(role = Role.Button, onClickLabel = "open ${routine.name}") { onOpenRoutine(routine.id) }
        .semantics { customActions = listOf(
            CustomAccessibilityAction("Duplicate ${routine.name}") { onDuplicate(); true },
            CustomAccessibilityAction("Delete ${routine.name}") { onDelete(); true }) }
        .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(routine.name, style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink)
            Text(Readout.routineLine(routine, nowMs), style = WindmillFont.body(13), color = skin.inkDim)
            waiting?.takeIf { it.id != standingProposalId }?.let { ProposalChip { onReview(it) } }
        }
        Box {
            IconButton(onClick = { menu = true }, modifier = Modifier.size(48.dp)) {
                Icon(painterResource(R.drawable.gym_more), "More for ${routine.name}", Modifier.size(24.dp), tint = skin.inkDim)
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = skin.raised) {
                DropdownMenuItem(text = { Text("Duplicate") }, onClick = { menu = false; onDuplicate() })
                DropdownMenuItem(text = { Text("Delete") }, onClick = { menu = false; onDelete() })
            }
        }
    }
}

@Composable
private fun ClaimCard(onSignIn: () -> Unit) {
    val skin = LocalGymColors.current
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
        modifier = Modifier
            .fillMaxWidth()
            .background(skin.raised, RoundedCornerShape(WindmillRadius.lg))
            .clickable(role = Role.Button, onClickLabel = "sign in", onClick = onSignIn)
            .padding(GymLayout.cardInset),
    ) {
        Text(
            "Your log is saved on this device.",
            style = WindmillFont.body(15, FontWeight.SemiBold),
            color = skin.ink,
        )
        Text(
            "Sign in to claim it — it opens on the web too.",
            style = GymType.numeral(12).copy(lineHeight = 17.sp),
            color = skin.inkDim,
        )
    }
}

@Composable
private fun EntryRow(entry: RoutineEntry, store: TrainingStore, onOpenMovement: (String) -> Unit) {
    val skin = LocalGymColors.current
    Row(Modifier.fillMaxWidth().heightIn(min = 112.dp)
        .clickable(role = Role.Button, onClickLabel = "open this movement") { onOpenMovement(entry.exerciseId) }
        .padding(20.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Box(Modifier.size(32.dp).background(skin.raised, RoundedCornerShape(8.dp)), contentAlignment = Alignment.Center) {
            Text(entry.position.toString(), style = GymType.numeral(13), color = skin.inkDim)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Text(Readout.movement(entry.exerciseId, store.catalog), style = WindmillFont.body(19, FontWeight.Bold), color = skin.ink)
            val target = Readout.target(entry.sets) + if (entry.sets.any { it.weightKg != null }) " kg" else ""
            Text(target, style = GymType.numeral(15), color = skin.inkDim)
            (entry.restSeconds ?: store.preferences.restSeconds)?.let {
                Text("Rest ${Readout.clock(it * 1000L)}", style = WindmillFont.body(13), color = skin.inkDim)
            }
        }
    }
}

// History is one read and holds both kinds: the day being created, and every proposal since.
@Composable
fun RoutineScreen(
    routineId: String,
    store: TrainingStore,
    isSignedIn: Boolean,
    backTo: String,
    onBack: () -> Unit,
    onStart: (String) -> Unit,
    onBuild: (RoutineDraft) -> Unit,
    onOpenMovement: (String) -> Unit,
    lookedAt: Set<String>,
    onReview: (Proposal) -> Unit,
    onOpenThread: (String) -> Unit,
) {
    val skin = LocalGymColors.current
    val nowMs = System.currentTimeMillis()
    val routine = store.routine(routineId)
    var history by remember(routineId) { mutableStateOf<List<RoutineEvent>>(emptyList()) }
    var unread by remember(routineId) { mutableStateOf<WriteFailure?>(null) }

    LaunchedEffect(routineId, isSignedIn, routine?.revision, routine?.pendingProposal?.id) {
        when (val read = store.routineHistory(routineId)) {
            is GymResult.Ok -> {
                history = read.value
                unread = null
            }
            is GymResult.Failed -> unread = read.why
        }
    }

    GymScreen(
        title = "Routine",
        onBack = onBack,
        backTo = backTo,
        bottomBar = {
            if (routine != null) {
                Column(Modifier.fillMaxWidth().background(skin.canvas).padding(horizontal = 20.dp)
                    .padding(top = 4.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { onStart(routine.id) }, shape = RoundedCornerShape(16.dp),
                        modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp)) {
                        Text("Start workout", style = WindmillFont.body(16, FontWeight.Bold))
                    }
                    TextButton(onClick = { onBuild(RoutineDraft.of(routine)) },
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                        Text("Edit routine", style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink)
                    }
                }
            }
        },
    ) {
        Column(
            verticalArrangement = Arrangement.spacedBy(24.dp),
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = GymLayout.gutter)
                .padding(top = 20.dp, bottom = GymLayout.scrollTailBand),
        ) {
            if (routine == null) {
                Text(
                    "That routine is no longer in your program. Everything you logged against it is still in the log.",
                    style = WindmillFont.body(16).copy(lineHeight = 24.sp),
                    color = skin.inkDim,
                )
                return@Column
            }

            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(routine.name, style = WindmillFont.display(40), color = skin.ink)
                val targets = routine.entries.sumOf { it.sets.size }
                val summary = listOf(Program.movements(routine.entries.size), Readout.setCount(targets)).joinToString(" · ")
                Text(summary, style = WindmillFont.body(16), color = skin.inkDim)
                routine.lastTrainedAtMs?.let {
                    Text("Last trained ${Readout.date(it)}", style = WindmillFont.body(14), color = skin.inkDim)
                }
            }

            routine.pendingProposal?.let { waiting ->
                ProposalCard(waiting, routine.name, nowMs, stillWaiting = waiting.id in lookedAt,
                    onReview = { onReview(waiting) })
            }

            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(skin.surface)) {
                routine.entries.sortedBy { it.position }.forEach { entry ->
                    EntryRow(entry, store, onOpenMovement)
                }
            }

            History(history, unread, nowMs, onReview, onOpenThread)
        }
    }
}

// Newest first, the creation row always last and not a door. The `Coach ›` door is drawn only where the
// source carries a thread, and a history that could not be read is not an empty one.
@Composable
private fun History(
    events: List<RoutineEvent>,
    unread: WriteFailure?,
    nowMs: Long,
    onReview: (Proposal) -> Unit,
    onOpenThread: (String) -> Unit,
) {
    val skin = LocalGymColors.current
    val drawn = events.filterNot { it.isPending }.mapNotNull { event ->
        event.line(nowMs)?.let { event to it }
    }
    if (drawn.isEmpty() && unread == null) return
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier.fillMaxWidth().padding(top = WindmillSpace.x2),
    ) {
        Text("History", style = GymType.numeral(11), color = skin.inkDim)
        if (unread != null) {
            Text(
                unread.line("this routine’s history is out of reach"),
                style = GymType.numeral(12),
                color = skin.inkDim,
            )
        }
        drawn.forEach { (event, line) ->
            val diff = event.proposal
            val conversation = diff?.source?.conversation
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.minimum)
                    .background(skin.raised, RoundedCornerShape(WindmillRadius.md))
                    .padding(start = WindmillSpace.x3),
            ) {
                Text(
                    line,
                    style = GymType.numeral(12).copy(lineHeight = 18.sp),
                    color = skin.inkDim,
                    modifier = Modifier
                        .weight(1f)
                        .then(
                            if (diff == null) Modifier
                            else Modifier.clickable(
                                role = Role.Button,
                                onClickLabel = "review this change",
                            ) { onReview(diff) },
                        ),
                )
                conversation?.let { threadId ->
                    Box(
                        contentAlignment = Alignment.Center,
                        modifier = Modifier
                            .heightIn(min = GymTap.minimum)
                            .clickable(role = Role.Button) { onOpenThread(threadId) }
                            .padding(horizontal = WindmillSpace.x2),
                    ) {
                        Text(
                            "Coach ›",
                            style = GymType.numeral(11, FontWeight.Bold),
                            color = skin.accent,
                            maxLines = 1,
                        )
                    }
                }
                if (diff != null && conversation == null) {
                    Chevron(Modifier.padding(end = WindmillSpace.x3))
                }
            }
        }
    }
}
