package works.windmill.gym.ui

import works.windmill.platform.design.WindmillSheet
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
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.R
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.sync.SeedExercises
import works.windmill.gym.store.RefusedWorkout
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillFont

@Composable
fun RoutinesScreen(
    store: TrainingStore,
    // Reviews opened and closed with nothing decided: those cards read `still waiting`.
    lookedAt: Set<String>,
    seat: String,
    onBuild: (RoutineDraft) -> Unit,
    onOpenRoutine: (String) -> Unit,
    onDeleteRoutine: suspend (String) -> Boolean,
    onReview: (Proposal) -> Unit,
) {
    val skin = LocalGymColors.current
    val nowMs = System.currentTimeMillis()
    val routines = store.routines.sortedByDescending { it.lastTrainedAtMs ?: Long.MIN_VALUE }
    val empty = store.allRoutines.isEmpty()
    val standing = store.pendingProposals.firstOrNull()
    val refusals = store.refusals.filterNot { it is RefusedWorkout }

    GymScreen(
        title = "Routines",
        actions = { YouSeat(seat) },
    ) {
        Box(Modifier.fillMaxSize()) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(
                    start = 16.dp,
                    end = 16.dp,
                    top = 8.dp,
                    bottom = 88.dp,
                ),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                if (refusals.isNotEmpty()) item("refusals") {
                    Refusals(refusals, store.catalog, onDismiss = { store.clearRefusals() })
                }

                items(store.unseenRemovalReceipts.values.toList(), key = { "receipt:${it.id}" }) { receipt ->
                    ProposalCard(receipt, receipt.routineName, nowMs, false) { onReview(receipt) }
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

                if (empty) {
                    item("empty") {
                        Text("No routines yet.", style = TextStyle(fontFamily = GymNativeType.sans,
                            fontWeight = FontWeight.ExtraBold, fontSize = 24.sp, lineHeight = 32.sp), color = skin.ink)
                    }
                } else {
                    items(routines, key = { it.id }) { routine ->
                        val delete: suspend () -> Boolean = { onDeleteRoutine(routine.id) }
                        DeleteSwipeRow(actionLabel = "Delete ${routine.name}", onDelete = delete) {
                            RoutineRow(routine, standing?.id, store.catalog, onOpenRoutine, delete, onReview)
                        }
                    }
                }
            }
            GymFab("New routine", onClick = { onBuild(RoutineDraft(position = store.allRoutines.size)) },
                modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp))
        }
    }
}

// The standing card owns its review target; other pending proposals keep a target on their routine.
@Composable
private fun RoutineRow(
    routine: Routine,
    standingProposalId: String?,
    catalog: List<Exercise>,
    onOpenRoutine: (String) -> Unit,
    onDelete: suspend () -> Boolean,
    onReview: (Proposal) -> Unit,
) {
    val skin = LocalGymColors.current
    val scope = rememberCoroutineScope()
    val waiting = routine.pendingProposal
    var menu by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().heightIn(min = 68.dp)
        .background(skin.canvas)
        .clickable(role = Role.Button, onClickLabel = "open ${routine.name}") { onOpenRoutine(routine.id) }
        .padding(start = 12.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(routine.name, style = GymNativeType.button, color = skin.ink)
            Text(routine.entries.sortedBy { it.position }.take(2)
                .joinToString(" · ") { Readout.movement(it.exerciseId, catalog) },
                style = TextStyle(fontFamily = GymNativeType.sans, fontSize = 13.sp, lineHeight = 18.sp), color = skin.inkDim)
            waiting?.takeIf { it.id != standingProposalId }?.let { ProposalChip { onReview(it) } }
        }
        Box {
            IconButton(onClick = { menu = true }, modifier = Modifier.size(48.dp)) {
                Icon(painterResource(R.drawable.gym_more), "More for ${routine.name}", Modifier.size(24.dp), tint = skin.inkDim)
            }
            GymMenu(expanded = menu, onDismissRequest = { menu = false }) {
                GymMenuItem("Delete", painterResource(R.drawable.gym_native_delete), destructive = true,
                    onClick = { menu = false; scope.launch { onDelete() } })
            }
        }
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
    WindmillSheet(
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
                                    val name = Readout.movement(entry.exerciseId, store.catalog)
                                    val yours = SeedExercises.all.none { it.id.record.string == entry.exerciseId }
                                    Text(if (yours) "$name · yours" else name,
                                        style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink)
                                    val target = Readout.targetWithUnit(entry.sets, store.catalog.find { it.id == entry.exerciseId })
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
                    TextButton(onClick = { onBuild(RoutineDraft.of(routine, store.catalog)) }, enabled = !starting,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                        Text("Edit routine", style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink)
                    }
                }
            }
        }
    }
}
