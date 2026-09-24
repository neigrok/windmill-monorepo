package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.R
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace
import works.windmill.platform.design.WindmillSheetWindow

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
    val compactAction = LocalDensity.current.fontScale > 1.3f

    GymScreen(
        title = "Routines",
        actions = {
            if (compactAction) {
                IconButton(
                    onClick = { onBuild(RoutineDraft(position = store.allRoutines.size)) },
                    modifier = Modifier.size(48.dp),
                ) {
                    Icon(Icons.Default.Add, "New routine", tint = skin.accent)
                }
            } else {
                TopAction("New routine") { onBuild(RoutineDraft(position = store.allRoutines.size)) }
            }
            YouSeat(seat)
        },
    ) {
        Column(Modifier.fillMaxSize()) {
            LazyColumn(
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(
                    start = GymLayout.gutter,
                    end = GymLayout.gutter,
                    top = 8.dp,
                    bottom = GymLayout.scrollTailBand,
                ),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                if (store.refusals.isNotEmpty()) item("refusals") {
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
                            catalog = store.catalog,
                            onOpenRoutine = onOpenRoutine,
                            onDelete = { onDeleteRoutine(routine.id) },
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
    catalog: List<Exercise>,
    onOpenRoutine: (String) -> Unit,
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
        RoutineRow(routine, standingProposalId, catalog, onOpenRoutine, onDelete, onReview)
    }
}

// A routine with a proposal wears the accent border. The chip — a dot, a count and its own target
// onto the diff — is drawn on the routines the standing card is NOT about, so no proposal is
// rendered twice.
@Composable
private fun RoutineRow(
    routine: Routine,
    standingProposalId: String?,
    catalog: List<Exercise>,
    onOpenRoutine: (String) -> Unit,
    onDelete: () -> Unit,
    onReview: (Proposal) -> Unit,
) {
    val skin = LocalGymColors.current
    val waiting = routine.pendingProposal
    var menu by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().heightIn(min = 68.dp)
        .background(skin.canvas)
        .clickable(role = Role.Button, onClickLabel = "open ${routine.name}") { onOpenRoutine(routine.id) }
        .semantics { customActions = listOf(
            CustomAccessibilityAction("Delete ${routine.name}") { onDelete(); true }) }
        .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(routine.name, style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink)
            Text(routine.entries.sortedBy { it.position }.take(2)
                .joinToString(" · ") { Readout.movement(it.exerciseId, catalog) },
                style = WindmillFont.body(13), color = skin.inkDim)
            waiting?.takeIf { it.id != standingProposalId }?.let { ProposalChip { onReview(it) } }
        }
        Box {
            IconButton(onClick = { menu = true }, modifier = Modifier.size(48.dp)) {
                Icon(painterResource(R.drawable.gym_more), "More for ${routine.name}", Modifier.size(24.dp), tint = skin.inkDim)
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = skin.raised) {
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RoutineSheet(
    routineId: String,
    store: TrainingStore,
    onDismiss: () -> Unit,
    onStart: (String) -> Unit,
    onBuild: (RoutineDraft) -> Unit,
    starting: Boolean = false,
    failure: String? = null,
) {
    val skin = LocalGymColors.current
    val routine = store.routine(routineId)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = skin.surface,
        scrimColor = skin.scrim,
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        dragHandle = {
            Box(Modifier.fillMaxWidth().height(24.dp), contentAlignment = Alignment.Center) {
                Box(Modifier.width(32.dp).height(4.dp).background(skin.inkDim, RoundedCornerShape(2.dp)))
            }
        },
        modifier = Modifier.testTag("routine-sheet"),
    ) {
        WindmillSheetWindow()
        Column(Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier.weight(1f, fill = false).fillMaxWidth()
                    .verticalScroll(rememberScrollState()).padding(horizontal = GymLayout.gutter)
                    .padding(top = 8.dp, bottom = 12.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                if (routine == null) {
                    Text(
                        "That routine is no longer in your program. Everything you logged against it is still in the log.",
                        style = WindmillFont.body(16).copy(lineHeight = 24.sp),
                        color = skin.inkDim,
                    )
                } else {
                    Text(routine.name, style = WindmillFont.display(28), color = skin.ink)
                    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(skin.raised),
                        verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        routine.entries.sortedBy { it.position }.forEach { entry ->
                            Row(Modifier.fillMaxWidth().heightIn(min = 68.dp).background(skin.surface)
                                .semantics(mergeDescendants = true) {}
                                .padding(horizontal = 16.dp, vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                Box(Modifier.size(32.dp).background(skin.raised, RoundedCornerShape(8.dp)),
                                    contentAlignment = Alignment.Center) {
                                    Text(entry.position.toString(), style = GymType.numeral(13), color = skin.inkDim)
                                }
                                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                    Text(Readout.movement(entry.exerciseId, store.catalog),
                                        style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink)
                                    val target = Readout.target(entry.sets) + if (entry.sets.any { it.weightKg != null }) " kg" else ""
                                    Text(target, style = GymType.numeral(13), color = skin.inkDim)
                                }
                            }
                        }
                    }
                }
            }
            if (routine != null) {
                Column(Modifier.fillMaxWidth().padding(horizontal = GymLayout.gutter)
                    .padding(top = 4.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    failure?.let { Text(it, style = WindmillFont.body(14), color = skin.alarmInk) }
                    Button(onClick = { onStart(routine.id) }, enabled = !starting, shape = RoundedCornerShape(16.dp),
                        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                        Text("Start workout", style = WindmillFont.body(16, FontWeight.Bold))
                    }
                    TextButton(onClick = { onBuild(RoutineDraft.of(routine)) }, enabled = !starting,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                        Text("Edit routine", style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink)
                    }
                }
            }
        }
    }
}
