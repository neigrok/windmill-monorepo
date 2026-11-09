package works.windmill.gym.ui

import works.windmill.platform.R as PlatformR
import works.windmill.platform.design.WindmillType
import androidx.compose.material3.MaterialTheme
import works.windmill.platform.design.WindmillSheet
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import works.windmill.gym.R
import works.windmill.gym.presentation.Proposal
import works.windmill.gym.presentation.Readout
import works.windmill.gym.presentation.Exercise
import works.windmill.gym.presentation.Routine
import works.windmill.gym.presentation.RoutineDraft
import works.windmill.gym.presentation.RoutineEntry
import works.windmill.gym.presentation.SetTarget
import works.windmill.gym.presentation.TheSix
import works.windmill.gym.domain.sync.SeedExercises
import works.windmill.gym.store.RefusedWorkout
import works.windmill.gym.store.RefusedWrite
import works.windmill.gym.store.RoutinesStore
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.WorkoutSession
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import works.windmill.platform.i18n.Words
import works.windmill.platform.i18n.text

// What the routines home and a routine's sheet draw.
@Stable
interface RoutinesState {
    val all: List<Routine>
    val catalog: List<Exercise>
    val pendingProposals: List<Proposal>
    val unseenRemovalReceipts: Map<String, Proposal>
    val refusals: List<RefusedWrite>
    fun routine(id: String): Routine?
}

// What the routines home asks of the stores.
interface RoutinesEvents {
    fun clearRefusals()
}

// The routines home over the room's stores.
class RoutinesBinding(
    private val routines: RoutinesStore,
    private val workout: WorkoutSession,
    private val dismissRefusals: () -> Unit,
) : RoutinesState, RoutinesEvents {
    constructor(store: TrainingStore) : this(store.routines, store.workout, store::clearRefusals)

    override val all: List<Routine> get() = routines.all
    override val catalog: List<Exercise> get() = routines.catalog
    override val pendingProposals: List<Proposal> get() = routines.pendingProposals
    override val unseenRemovalReceipts: Map<String, Proposal> get() = routines.unseenRemovalReceipts
    override val refusals: List<RefusedWrite> get() = workout.refusals
    override fun routine(id: String): Routine? = routines.routine(id)
    override fun clearRefusals() = dismissRefusals()
}

@Composable
fun RoutinesScreen(
    state: RoutinesState,
    events: RoutinesEvents,
    // Reviews opened and closed with nothing decided: those cards read `still waiting`.
    lookedAt: Set<String>,
    seat: String,
    onBuild: (RoutineDraft) -> Unit,
    onOpenRoutine: (String) -> Unit,
    onDeleteRoutine: suspend (String) -> Boolean,
    onReview: (Proposal) -> Unit,
    transient: SnackbarHostState? = null,
) {
    val colors = MaterialTheme.colorScheme
    val nowMs = System.currentTimeMillis()
    val routines = state.all.sortedByDescending { it.lastTrainedAtMs ?: Long.MIN_VALUE }
    val empty = state.all.isEmpty()
    val standing = state.pendingProposals.firstOrNull()
    val refusals = state.refusals.filterNot { it is RefusedWorkout }

    GymScreen(
        title = stringResource(R.string.gym_routines_title),
        actions = { YouSeat(seat) },
        transient = transient,
        floatingActionButton = { GymFab(stringResource(R.string.gym_routines_new_routine), onClick = { onBuild(RoutineDraft(position = state.all.size)) }) },
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
                    Refusals(refusals, state.catalog, onDismiss = { events.clearRefusals() })
                }

                items(state.unseenRemovalReceipts.values.toList(), key = { "receipt:${it.id}" }) { receipt ->
                    ProposalCard(receipt, receipt.routineNamed, nowMs, false) { onReview(receipt) }
                }

                // The newest waiting card, one at a time; the others keep their dot on their
                // routine's row, and the routine this card is about draws no dot of its own.
                standing?.let { waiting ->
                    item("proposal") {
                        ProposalCard(
                            proposal = waiting,
                            routineNamed = state.routine(waiting.routineId)?.name?.let(Words::Plain) ?: waiting.routineNamed,
                            nowMs = nowMs,
                            stillWaiting = waiting.id in lookedAt,
                            onReview = { onReview(waiting) },
                        )
                    }
                }

                if (empty) {
                    item("empty") {
                        Text(stringResource(R.string.gym_routines_empty), style = GymType.emptyRoutinesTitle, color = colors.onSurface)
                    }
                } else {
                    items(routines, key = { it.id }) { routine ->
                        val delete: suspend () -> Boolean = { onDeleteRoutine(routine.id) }
                        DeleteSwipeRow(actionLabel = stringResource(R.string.gym_routines_delete_named, routine.name), onDelete = delete) {
                            RoutineRow(routine, standing?.id, state.catalog, onOpenRoutine, delete, onReview)
                        }
                    }
                }
            }
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
    val colors = MaterialTheme.colorScheme
    val scope = rememberCoroutineScope()
    val waiting = routine.pendingProposal
    var menu by remember { mutableStateOf(false) }
    ListItem(
        headlineContent = { Text(routine.name, style = GymType.nativeRowTitle, color = colors.onSurface) },
        supportingContent = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(routine.entries.sortedBy { it.position }.take(2)
                    .joinToString(" · ") { Readout.movement(it.exerciseId, catalog) },
                    style = GymType.nativeDetail, color = colors.onSurfaceVariant)
                waiting?.takeIf { it.id != standingProposalId }?.let { ProposalChip { onReview(it) } }
            }
        },
        trailingContent = {
            Box {
                IconButton(onClick = { menu = true }) {
                    Icon(Icons.Filled.MoreVert, stringResource(R.string.gym_routines_more_named, routine.name), tint = colors.onSurfaceVariant)
                }
                GymMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    GymMenuItem(stringResource(PlatformR.string.platform_delete), painterResource(R.drawable.gym_native_delete), destructive = true,
                        onClick = { menu = false; scope.launch { onDelete() } })
                }
            }
        },
        modifier = Modifier.fillMaxWidth()
            .clickable(role = Role.Button, onClickLabel = stringResource(R.string.gym_routines_open_named, routine.name)) { onOpenRoutine(routine.id) },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RoutineSheet(
    routineId: String,
    state: RoutinesState,
    onDismiss: () -> Unit,
    onStart: (String) -> Unit,
    onBuild: (RoutineDraft) -> Unit,
    starting: Boolean = false,
    failure: String? = null,
) {
    val colors = MaterialTheme.colorScheme
    val gymColors = MaterialTheme.gymColors
    val routine = state.routine(routineId)
    WindmillSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = colors.surfaceContainer,
        scrimColor = colors.scrim,
        modifier = Modifier.testTag("routine-sheet"),
    ) {
        Column(Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier.weight(1f, fill = false).fillMaxWidth()
                    .verticalScroll(rememberScrollState()).padding(horizontal = GymLayout.listInset)
                    .padding(top = 8.dp, bottom = 12.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                if (routine == null) {
                    Text(
                        stringResource(R.string.gym_routines_gone),
                        style = WindmillType.paragraphLoose,
                        color = colors.onSurfaceVariant,
                    )
                } else {
                    Text(routine.name, style = GymType.routineSheetTitle, color = colors.onSurface)
                    Column(Modifier.fillMaxWidth()) {
                        routine.entries.sortedBy { it.position }.forEach { entry ->
                            val name = Readout.movement(entry.exerciseId, state.catalog)
                            val yours = SeedExercises.all.none { it.id.record.string == entry.exerciseId }
                            ListItem(
                                leadingContent = {
                                    Box(Modifier.size(40.dp).background(colors.secondaryContainer, CircleShape), contentAlignment = Alignment.Center) {
                                        Text(entry.position.toString(), style = GymType.numeral, color = colors.onSecondaryContainer)
                                    }
                                },
                                headlineContent = {
                                    Text(if (yours) stringResource(R.string.gym_routines_movement_yours, name) else name, style = WindmillType.label, color = colors.onSurface)
                                },
                                supportingContent = {
                                    Text(Readout.scheme(entry.sets, state.catalog.find { it.id == entry.exerciseId }).text(),
                                        style = GymType.numeral, color = colors.onSurfaceVariant)
                                },
                                colors = ListItemDefaults.colors(containerColor = colors.surfaceContainer),
                                modifier = Modifier.fillMaxWidth().semantics(mergeDescendants = true) {},
                            )
                        }
                    }
                }
            }
            if (routine != null) {
                Column(Modifier.fillMaxWidth().padding(horizontal = GymLayout.listInset)
                    .padding(top = 4.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    failure?.let { Text(it, style = WindmillType.supporting, color = gymColors.alarmInk,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }
                    Button(onClick = { onStart(routine.id) }, enabled = !starting,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                        Text(stringResource(R.string.gym_routines_start_workout), style = WindmillType.label)
                    }
                    TextButton(onClick = { onBuild(RoutineDraft.of(routine, state.catalog)) }, enabled = !starting,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                        Text(stringResource(R.string.gym_routines_edit_routine), style = WindmillType.label)
                    }
                }
            }
        }
    }
}

private data class PreviewRoutinesState(
    override val all: List<Routine> = emptyList(),
    override val catalog: List<Exercise> = TheSix.movements,
    override val pendingProposals: List<Proposal> = emptyList(),
    override val unseenRemovalReceipts: Map<String, Proposal> = emptyMap(),
    override val refusals: List<RefusedWrite> = emptyList(),
) : RoutinesState {
    override fun routine(id: String): Routine? = all.firstOrNull { it.id == id }
}

private object PreviewRoutinesEvents : RoutinesEvents {
    override fun clearRefusals() = Unit
}

@Composable
private fun RoutinesPreview(state: PreviewRoutinesState) {
    GymPreview {
        RoutinesScreen(state, PreviewRoutinesEvents, lookedAt = emptySet(), seat = "A", onBuild = {}, onOpenRoutine = {},
            onDeleteRoutine = { false }, onReview = {})
    }
}

// Three routines, the most recently trained first.
@DarkAndDaylight
@Composable
private fun ProgramPreview() {
    val day = 86_400_000L
    val today = 1_761_984_000_000L
    fun entry(position: Int, exerciseId: String, reps: Int, weightKg: Double) =
        RoutineEntry(position, exerciseId, List(3) { SetTarget(reps, weightKg) })
    RoutinesPreview(PreviewRoutinesState(all = listOf(
        Routine("routine-push", "Push Day", 0, today - 2 * day,
            listOf(entry(1, "bench-press", 8, 75.0), entry(2, "overhead-press", 6, 47.5))),
        Routine("routine-pull", "Pull Day", 1, today - day,
            listOf(entry(1, "barbell-row", 8, 60.0), entry(2, "chin-up", 6, 0.0))),
        Routine("routine-legs", "Legs", 2, null,
            listOf(entry(1, "back-squat", 5, 100.0), entry(2, "deadlift", 5, 120.0))),
    )))
}

@DarkAndDaylight
@Composable
private fun NoRoutinesPreview() = RoutinesPreview(PreviewRoutinesState())
