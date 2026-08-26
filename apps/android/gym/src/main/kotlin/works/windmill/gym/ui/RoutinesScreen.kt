package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.domain.Program
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.RoutineEntry
import works.windmill.gym.domain.RoutineEvent
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// A change to a routine mints a card rather than a write, and it waits here until it is decided.
@Composable
fun RoutinesScreen(
    store: TrainingStore,
    isSignedIn: Boolean,
    origin: String,
    // Reviews opened and closed with nothing decided: those cards read `still waiting`.
    lookedAt: Set<String>,
    onJustStart: () -> Unit,
    onBuild: (RoutineDraft) -> Unit,
    onOpenRoutine: (String) -> Unit,
    onReview: (Proposal) -> Unit,
    onOpenSettings: () -> Unit,
    onSignIn: () -> Unit,
) {
    val nowMs = System.currentTimeMillis()
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = WindmillSpace.x5)
            .padding(top = WindmillSpace.x10, bottom = WindmillSpace.x8),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
            Text("Routines", style = WindmillFont.display(32), color = GymSkin.ink)
            if (store.routines.isNotEmpty()) {
                Text(
                    "${Readout.routineCount(store.routines.size)} · nothing running",
                    style = GymType.numeral(13),
                    color = GymSkin.inkFaint,
                )
            }
        }

        Refusals(store.refusals, store.catalog, onDismiss = { store.clearRefusals() })

        // The newest waiting card, one at a time; the others keep their dot on their routine's row.
        store.pendingProposals.firstOrNull()?.let { waiting ->
            val about = store.routine(waiting.routineId)
            ProposalCard(
                proposal = waiting,
                routineName = about?.name ?: waiting.routineName,
                nowMs = nowMs,
                stillWaiting = waiting.id in lookedAt,
                onReview = { onReview(waiting) },
            )
        }

        if (!isSignedIn) ClaimCard(onSignIn)

        if (store.routines.isEmpty()) {
            EmptyRoutines(
                onBuild = { onBuild(RoutineDraft(position = 0)) },
                onJustStart = onJustStart,
            )
        } else {
            store.routines
                .sortedByDescending { it.lastTrainedAtMs ?: Long.MIN_VALUE }
                .forEach { routine ->
                    RoutineRow(routine, nowMs, onOpenRoutine, onReview)
                }

            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.primary - 8.dp)
                    .background(GymSkin.accent, RoundedCornerShape(WindmillRadius.lg))
                    .clickable { onBuild(RoutineDraft(position = store.routines.size)) },
            ) {
                Text(
                    "New routine",
                    style = WindmillFont.body(16, FontWeight.Bold),
                    color = GymSkin.onAccent,
                )
            }
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.minimum + 6.dp)
                    .clickable(onClick = onJustStart),
            ) {
                Text(
                    "Just start logging",
                    style = WindmillFont.body(15, FontWeight.SemiBold),
                    color = GymSkin.inkDim,
                )
            }

            if (isSignedIn) ConnectInvitation(origin)
        }

        SettingsDoor(onOpenSettings)
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
            Text("+", style = WindmillFont.display(26), color = GymSkin.inkFaint)
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
                .clickable(onClick = onBuild),
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
                .clickable(onClick = onJustStart),
        ) {
            Text(
                "Just start logging",
                style = WindmillFont.body(16, FontWeight.SemiBold),
                color = GymSkin.accent,
            )
        }
    }
}

// A routine with a proposal wears a dot and a count, and the chip is its own target onto the diff.
@Composable
private fun RoutineRow(
    routine: Routine,
    nowMs: Long,
    onOpenRoutine: (String) -> Unit,
    onReview: (Proposal) -> Unit,
) {
    val waiting = routine.pendingProposal
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
            .clickable { onOpenRoutine(routine.id) }
            .padding(horizontal = WindmillSpace.x4, vertical = WindmillSpace.x3),
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
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (routine.untested) UntestedChip()
                waiting?.let { ProposalChip { onReview(it) } }
            }
            Text(Readout.routineLine(routine, nowMs), style = GymType.numeral(11), color = GymSkin.inkFaint)
        }
        Text(
            "›",
            style = WindmillFont.body(17, FontWeight.SemiBold),
            color = GymSkin.inkFaint,
            modifier = Modifier.padding(start = WindmillSpace.x3),
        )
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
            .clickable(onClick = onSignIn)
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
            .clickable(onClick = onOpenSettings),
    ) {
        Text("Gym settings", style = GymType.numeral(13), color = GymSkin.inkFaint)
        Spacer(Modifier.weight(1f))
        Text("›", style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.inkFaint)
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
            .clickable { onOpenMovement(entry.exerciseId) },
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
    backLabel: String,
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
    var unread by remember(routineId) { mutableStateOf(false) }

    LaunchedEffect(routineId, isSignedIn, routine?.revision, routine?.pendingProposal?.id) {
        when (val read = store.routineHistory(routineId)) {
            is GymResult.Ok -> {
                history = read.value
                unread = false
            }
            is GymResult.Failed -> unread = true
        }
    }

    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = WindmillSpace.x5)
            .padding(bottom = WindmillSpace.x8),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
                modifier = Modifier.heightIn(min = GymTap.minimum).clickable(onClick = onBack),
            ) {
                Text("‹", style = WindmillFont.body(20, FontWeight.SemiBold), color = GymSkin.inkDim)
                Text(backLabel, style = WindmillFont.body(14, FontWeight.Bold), color = GymSkin.inkDim)
            }
            Spacer(Modifier.weight(1f))
            if (routine != null) {
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .heightIn(min = GymTap.minimum)
                        .clickable { onBuild(RoutineDraft.of(routine)) }
                        .padding(horizontal = WindmillSpace.x2),
                ) {
                    Text("Edit", style = WindmillFont.body(15, FontWeight.Bold), color = GymSkin.accent)
                }
            }
        }

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
        Text(routine.name, style = WindmillFont.display(30), color = GymSkin.ink)
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        ) {
            if (head.untested) {
                Box(
                    Modifier
                        .background(GymSkin.accentSoft, RoundedCornerShape(WindmillRadius.full))
                        .padding(horizontal = WindmillSpace.x2, vertical = 2.dp),
                ) {
                    Text("untested", style = GymType.numeral(11, FontWeight.Bold), color = GymSkin.accent)
                }
            }
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

        Program.openLine(
            routine.entries.sortedBy { it.position }
                .filter { it.targetSets == null }
                .map { Readout.movement(it.exerciseId, store.catalog) }
        )?.let {
            Text(it, style = WindmillFont.body(14).copy(lineHeight = 21.sp), color = GymSkin.inkDim)
        }

        // The routine's name is the screen title, so the verb is locked — literally "Start workout".
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.primary - 8.dp)
                .background(GymSkin.accent, RoundedCornerShape(WindmillRadius.lg))
                .clickable { onStart(routine.id) },
        ) {
            Text(
                "Start workout",
                style = WindmillFont.body(16, FontWeight.Bold),
                color = GymSkin.onAccent,
            )
        }

        History(history, unread, nowMs, onReview, onOpenThread)
    }
}

// Newest first, the creation row always last and not a door. The `Coach ›` door is drawn only where the
// source carries a thread, and a history that could not be read is not an empty one.
@Composable
private fun History(
    events: List<RoutineEvent>,
    unread: Boolean,
    nowMs: Long,
    onReview: (Proposal) -> Unit,
    onOpenThread: (String) -> Unit,
) {
    val drawn = events.filterNot { it.isPending }.mapNotNull { event ->
        event.line(nowMs)?.let { event to it }
    }
    if (drawn.isEmpty() && !unread) return
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier.fillMaxWidth().padding(top = WindmillSpace.x2),
    ) {
        Text("History", style = GymType.numeral(11), color = GymSkin.inkFaint)
        if (unread) {
            Text(
                "the log didn’t answer — this routine’s history is out of reach",
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
                        .then(if (diff == null) Modifier else Modifier.clickable { onReview(diff) }),
                )
                conversation?.let { threadId ->
                    Box(
                        contentAlignment = Alignment.Center,
                        modifier = Modifier
                            .heightIn(min = GymTap.minimum)
                            .clickable { onOpenThread(threadId) }
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
                    Text(
                        "›",
                        style = WindmillFont.body(15, FontWeight.SemiBold),
                        color = GymSkin.inkFaint,
                        modifier = Modifier.padding(end = WindmillSpace.x3),
                    )
                }
            }
        }
    }
}
