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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.domain.Program
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.RoutineEntry
import works.windmill.gym.domain.RoutineEvent
import works.windmill.gym.domain.TargetEntry
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.WriteFailure
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// A change to a routine mints a card rather than a write, and it waits here until it is decided.
//
// The band at the foot holds `Just start logging`, because that is what a lifter does with a bar in
// their hands; making a new routine is planning work and rides the top bar, where nobody needs to
// reach one-handed. The connect pitch is not here at all — it interrupted the one screen a lifter
// opens to start training, and gym settings keeps the door.
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
    onOpenSettings: () -> Unit,
    onSignIn: () -> Unit,
) {
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
            IconButton(onClick = { onBuild(RoutineDraft(position = store.allRoutines.size)) }) {
                Icon(Icons.Filled.Add, contentDescription = "New routine")
            }
            YouSeat(seat)
        },
    ) {
        Column(Modifier.fillMaxSize()) {
            LazyColumn(
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(
                    start = WindmillSpace.x5,
                    end = WindmillSpace.x5,
                    bottom = WindmillSpace.x6,
                ),
                verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
            ) {
                if (routines.isNotEmpty()) {
                    item("count") {
                        Text(
                            Readout.routineCount(routines.size),
                            style = GymType.numeral(13),
                            color = GymSkin.inkFaint,
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
                        EmptyRoutines(
                            onBuild = { onBuild(RoutineDraft(position = 0)) },
                            onJustStart = onJustStart,
                        )
                    }
                } else {
                    items(routines, key = { it.id }) { routine ->
                        SwipeableRoutineRow(
                            routine = routine,
                            standingProposalId = standing?.id,
                            nowMs = nowMs,
                            onOpenRoutine = onOpenRoutine,
                            onDuplicate = {
                                onBuild(RoutineDraft.of(routine).duplicated(position = store.allRoutines.size))
                            },
                            onDelete = { onDeleteRoutine(routine.id) },
                            onReview = onReview,
                        )
                    }
                }

                item("settings") { SettingsDoor(onOpenSettings) }
            }

            // The reach band. The empty state above keeps its own two-button answer, so this one is
            // drawn only where there is already a program to start from.
            if (!empty) {
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = WindmillSpace.x5)
                        .padding(top = WindmillSpace.x2, bottom = WindmillSpace.x3)
                        .heightIn(min = GymTap.primary)
                        .background(GymSkin.accent, RoundedCornerShape(WindmillRadius.lg))
                        .clickable(role = Role.Button, onClick = onJustStart),
                ) {
                    Text(
                        "Just start logging",
                        style = WindmillFont.body(17, FontWeight.Bold),
                        color = GymSkin.onAccent,
                    )
                }
            }
        }
    }
}

@Composable
private fun EmptyRoutines(onBuild: () -> Unit, onJustStart: () -> Unit) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = WindmillSpace.x6),
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .size(62.dp)
                .dashedEdge(GymSkin.lineStrong, WindmillRadius.lg),
        ) {
            Icon(
                Icons.Filled.Add,
                contentDescription = null,
                tint = GymSkin.inkFaint,
                modifier = Modifier.size(26.dp),
            )
        }
        Text("No routines yet", style = WindmillFont.display(20), color = GymSkin.ink)
        Text(
            "A routine is one training day written down — the movements, in order, with your targets.",
            style = WindmillFont.body(15).copy(lineHeight = 23.sp),
            color = GymSkin.inkDim,
            textAlign = TextAlign.Center,
        )
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.primary)
                .background(GymSkin.accent, RoundedCornerShape(WindmillRadius.lg))
                .clickable(role = Role.Button, onClick = onBuild),
        ) {
            Text(
                "Build a routine",
                style = WindmillFont.body(17, FontWeight.Bold),
                color = GymSkin.onAccent,
            )
        }
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.primary - 10.dp)
                .border(1.dp, GymSkin.lineStrong, RoundedCornerShape(WindmillRadius.lg))
                .clickable(role = Role.Button, onClick = onJustStart),
        ) {
            Text(
                "Just start logging",
                style = WindmillFont.body(16, FontWeight.SemiBold),
                color = GymSkin.accent,
            )
        }
    }
}

// Trailing swipe, one action, and it is Delete — Duplicate stays in the overflow, because two
// trailing actions hide the row's own name behind them and a lifter cannot see WHICH routine they
// are deciding about while they decide.
//
// LAW 1 is satisfied here for free and by the overflow, not by the swipe: the same Delete is a real
// button a screen reader can reach, so no custom action is declared twice on this row.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SwipeableRoutineRow(
    routine: Routine,
    standingProposalId: String?,
    nowMs: Long,
    onOpenRoutine: (String) -> Unit,
    onDuplicate: () -> Unit,
    onDelete: () -> Unit,
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
        RoutineRow(routine, standingProposalId, nowMs, onOpenRoutine, onDuplicate, onDelete, onReview)
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
    onDuplicate: () -> Unit,
    onDelete: () -> Unit,
    onReview: (Proposal) -> Unit,
) {
    val waiting = routine.pendingProposal
    var menuUp by remember { mutableStateOf(false) }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum + 12.dp)
            .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.lg))
            .border(
                1.dp,
                if (waiting == null) GymSkin.line else GymSkin.accent,
                RoundedCornerShape(WindmillRadius.lg),
            )
            .clickable(role = Role.Button, onClickLabel = "open ${routine.name}") {
                onOpenRoutine(routine.id)
            }
            .padding(start = WindmillSpace.x4, top = WindmillSpace.x2, bottom = WindmillSpace.x2),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
            ) {
                Text(
                    routine.name,
                    style = WindmillFont.body(17, FontWeight.Bold),
                    color = GymSkin.ink,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (routine.untested) UntestedChip()
                waiting?.takeIf { it.id != standingProposalId }?.let { ProposalChip { onReview(it) } }
            }
            Text(Readout.routineLine(routine, nowMs), style = GymType.numeral(11), color = GymSkin.inkFaint)
        }
        Box {
            IconButton(onClick = { menuUp = true }) {
                Icon(
                    Icons.Filled.MoreVert,
                    contentDescription = "More for ${routine.name}",
                    tint = GymSkin.inkFaint,
                )
            }
            DropdownMenu(
                expanded = menuUp,
                onDismissRequest = { menuUp = false },
                containerColor = GymSkin.raised,
            ) {
                DropdownMenuItem(
                    text = { Text("Duplicate", color = GymSkin.ink) },
                    onClick = {
                        menuUp = false
                        onDuplicate()
                    },
                )
                DropdownMenuItem(
                    text = { Text("Delete", color = GymSkin.alarmInk) },
                    onClick = {
                        menuUp = false
                        onDelete()
                    },
                )
            }
        }
    }
}

// `untested` is derived, never stored: the day the first session starts the word goes.
@Composable
private fun UntestedChip() {
    Box(
        Modifier
            .background(GymSkin.accentSoft, RoundedCornerShape(WindmillRadius.full))
            .padding(horizontal = WindmillSpace.x2, vertical = 2.dp),
    ) {
        Text("untested", style = GymType.numeral(11, FontWeight.Bold), color = GymSkin.accent)
    }
}

@Composable
private fun ClaimCard(onSignIn: () -> Unit) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
        modifier = Modifier
            .fillMaxWidth()
            .background(GymSkin.raised, RoundedCornerShape(WindmillRadius.lg))
            .clickable(role = Role.Button, onClickLabel = "sign in", onClick = onSignIn)
            .padding(WindmillSpace.x4),
    ) {
        Text(
            "Your log is saved on this device.",
            style = WindmillFont.body(15, FontWeight.SemiBold),
            color = GymSkin.ink,
        )
        Text(
            "Sign in to claim it to your account — and open it on the web.",
            style = GymType.numeral(12).copy(lineHeight = 17.sp),
            color = GymSkin.inkFaint,
        )
    }
}

@Composable
private fun SettingsDoor(onOpenSettings: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum)
            .clickable(role = Role.Button, onClick = onOpenSettings),
    ) {
        Text("Gym settings", style = GymType.numeral(13), color = GymSkin.inkFaint)
        Spacer(Modifier.weight(1f))
        Chevron()
    }
}

@Composable
private fun EntryRow(entry: RoutineEntry, store: TrainingStore, onOpenMovement: (String) -> Unit) {
    val movement = store.catalog.firstOrNull { it.id == entry.exerciseId }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum)
            .clickable(role = Role.Button, onClickLabel = "open this movement") {
                onOpenMovement(entry.exerciseId)
            },
    ) {
        Text(
            movement?.name ?: entry.exerciseId,
            style = WindmillFont.body(14),
            color = GymSkin.inkDim,
        )
        if (movement?.custom == true) {
            Text(
                " · yours",
                style = GymType.numeral(11),
                color = GymSkin.inkFaint,
            )
        }
        Spacer(Modifier.weight(1f))
        Text(
            Readout.target(entry.targetSets, entry.targetReps, entry.targetWeightKg),
            style = GymType.numeral(12),
            color = if (entry.targetSets == null) GymSkin.inkFaint else GymSkin.targetInk,
        )
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
        title = routine?.name ?: "Routine",
        onBack = onBack,
        backTo = backTo,
        actions = {
            if (routine != null) {
                TopAction("Edit") { onBuild(RoutineDraft.of(routine)) }
            }
        },
        // The reach band: the one thing a lifter does here with a bar in their hands, pinned above
        // the safe-bottom inset and out of the scroll — the room's Scaffold already pads a pushed
        // screen for the navigation bar, so this band sits on top of that padding. The routine's
        // name is the screen title, so the verb is locked — literally "Start workout".
        bottomBar = {
            if (routine != null) {
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(GymSkin.canvas)
                        .padding(horizontal = WindmillSpace.x5)
                        .padding(top = WindmillSpace.x2, bottom = WindmillSpace.x3)
                        .heightIn(min = GymTap.primary)
                        .background(GymSkin.accent, RoundedCornerShape(WindmillRadius.lg))
                        .clickable(role = Role.Button) { onStart(routine.id) },
                ) {
                    Text(
                        "Start workout",
                        style = WindmillFont.body(17, FontWeight.Bold),
                        color = GymSkin.onAccent,
                    )
                }
            }
        },
    ) {
        Column(
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = WindmillSpace.x5)
                .padding(bottom = WindmillSpace.x8),
        ) {
            if (routine == null) {
                Text(
                    "That routine is no longer in your program. Everything you logged against it is still in the log.",
                    style = WindmillFont.body(16).copy(lineHeight = 24.sp),
                    color = GymSkin.inkDim,
                )
                return@Column
            }

            // The routine came off the LIST and carries no history of its own.
            val head = Program.head(routine, history, nowMs)
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
            ) {
                if (head.untested) UntestedChip()
                Text(head.line, style = GymType.numeral(12), color = GymSkin.inkFaint)
            }

            routine.pendingProposal?.let { waiting ->
                ProposalCard(waiting, routine.name, nowMs, stillWaiting = waiting.id in lookedAt,
                    onReview = { onReview(waiting) })
            }

            Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
                routine.entries.sortedBy { it.position }.forEach { entry ->
                    EntryRow(entry, store, onOpenMovement)
                }
            }

            // Once beneath the list and never per row: each open row already reads `open` in its own
            // target column — that word says WHICH, and this sentence says what it means.
            if (routine.entries.any { it.targetSets == null }) {
                Text(
                    TargetEntry.openLine,
                    style = WindmillFont.body(14).copy(lineHeight = 21.sp),
                    color = GymSkin.inkDim,
                )
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
    val drawn = events.filterNot { it.isPending }.mapNotNull { event ->
        event.line(nowMs)?.let { event to it }
    }
    if (drawn.isEmpty() && unread == null) return
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier.fillMaxWidth().padding(top = WindmillSpace.x2),
    ) {
        Text("History", style = GymType.numeral(11), color = GymSkin.inkFaint)
        if (unread != null) {
            Text(
                unread.line("this routine’s history is out of reach"),
                style = GymType.numeral(12),
                color = GymSkin.inkDim,
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
                    .background(GymSkin.raised, RoundedCornerShape(WindmillRadius.md))
                    .padding(start = WindmillSpace.x3),
            ) {
                Text(
                    line,
                    style = GymType.numeral(12).copy(lineHeight = 18.sp),
                    color = GymSkin.inkDim,
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
                            color = GymSkin.accent,
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
