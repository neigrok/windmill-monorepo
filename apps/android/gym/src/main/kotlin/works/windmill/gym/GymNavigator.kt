package works.windmill.gym

import androidx.activity.BackEventCompat
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.SeekableTransitionState
import androidx.compose.animation.core.rememberTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.util.lerp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import works.windmill.gym.coach.Ask
import works.windmill.gym.coach.Threads
import works.windmill.gym.domain.Bodyweight
import works.windmill.gym.domain.ConnectedLog
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Note
import works.windmill.gym.domain.Notes
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.SessionDetail
import works.windmill.gym.domain.SessionSummary
import works.windmill.platform.design.NavigationMotion
import works.windmill.platform.design.animationsOn
import works.windmill.platform.net.WindmillJson
import works.windmill.platform.telemetry.Telemetry
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue

internal enum class Tab(val title: String) {
    Routines("Routines"),
    Log("The log"),
    Coach("Coach"),
}

// Saved as its NAME: a Bundle holding an entry this build does not have must land on home, not
// crash the restore.
internal fun restoredTab(saved: Any?): Tab =
    Tab.entries.firstOrNull { it.name == saved } ?: Tab.Routines

internal val tabSaver: Saver<Tab, Any> = Saver(save = { it.name }, restore = ::restoredTab)

// A session travels as the ROW the list already holds, which carries facts no other read gives back;
// so does a note, which the list just read and the editor edits whole. A movement and
// thread travel as IDS, because what they say changes under them. `Coach` carries a DRAFT, never the
// thread — the thread is hoisted into the room so it outlives this stack. A proposal review is not a
// destination at all: it is a sheet over whichever of these is standing.
@Serializable
internal sealed interface Away {
    @Serializable
    data class Session(val summary: SessionSummary, val detail: SessionDetail? = null) : Away
    @Serializable
    data class Movement(val exerciseId: String, val focusSessionId: String? = null) : Away
    @Serializable
    data class Coach(val seed: String = "") : Away
    @Serializable
    data object Threads : Away
    @Serializable
    data class Thread(val threadId: String) : Away
    @Serializable
    data object Connections : Away
    @Serializable
    data object Notes : Away
    @Serializable
    data class NoteEditor(val note: Note?, val seedTitle: String) : Away
    @Serializable
    data object Bodyweight : Away
    @Serializable
    data object OnThisPhone : Away
    @Serializable
    data class InspectWorkout(val id: String) : Away
}

// What an entry says about itself, whatever it carries: which screen it is (a session whose detail arrives later is
// still the same screen), the `gym_screen_viewed` label, and the way-back line a screen above it shows. Names are read
// off the catalogue, so a rename moves the way back too.
internal val Away.key: String
    get() = when (this) {
        is Away.Session -> "session:${summary.id}"
        is Away.Movement -> "movement:$exerciseId"
        is Away.Coach -> "coach"
        Away.Threads -> "threads"
        is Away.Thread -> "thread:$threadId"
        Away.Connections -> "connections"
        Away.Notes -> "notes"
        is Away.NoteEditor -> "note:${note?.id.orEmpty()}"
        Away.Bodyweight -> "bodyweight"
        Away.OnThisPhone -> "on-this-phone"
        is Away.InspectWorkout -> "inspect:$id"
    }

internal val Away.screen: String
    get() = when (this) {
        is Away.Session -> "session"
        is Away.Movement -> "movement"
        is Away.Coach -> "coach"
        Away.Threads -> "threads"
        is Away.Thread -> "thread"
        Away.Connections -> "connections"
        Away.Notes -> "notes"
        is Away.NoteEditor -> "note_editor"
        Away.Bodyweight -> "bodyweight"
        Away.OnThisPhone -> "on_this_phone"
        is Away.InspectWorkout -> "workout_inspect"
    }

internal fun Away.wayBack(catalog: List<Exercise>): String = when (this) {
    is Away.Session -> summary.plan?.routine ?: Readout.noRoutine
    is Away.Movement -> Readout.movement(exerciseId, catalog)
    is Away.Coach -> Ask.title
    Away.Threads -> Threads.title
    // The noun, not the thread's title: a title is the lifter's first message verbatim.
    is Away.Thread -> Threads.conversation
    Away.Connections -> ConnectedLog.title
    Away.Notes, is Away.NoteEditor -> Notes.title
    Away.Bodyweight -> Bodyweight.title
    Away.OnThisPhone, is Away.InspectWorkout -> "On this phone"
}

internal fun awaySaver(telemetry: Telemetry) = Saver<List<Away>, String>(
    save = { WindmillJson.encodeToString(ListSerializer(Away.serializer()), it) },
    restore = { raw -> runCatching {
        val retained = WindmillJson.parseToJsonElement(raw).jsonArray.filterNot {
            it.jsonObject["type"]?.jsonPrimitive?.content == "works.windmill.gym.Away.Settings"
        }
        WindmillJson.decodeFromJsonElement(ListSerializer(Away.serializer()), JsonArray(retained))
    }
        .onFailure { telemetry.failure("gym.restoreNavigation", it) }.getOrDefault(emptyList()) },
)

// Back has five meanings on this surface and only one of them is a pop. The finish receipt is not
// among them: it is a sheet, and a sheet answers back by coming down.
internal enum class BackMeans(val previews: Boolean) {
    HideTheWorkout(previews = true),
    // The editor: back is Cancel and it leaves the whole draft.
    LeaveTheDraft(previews = true),
    PopOnePushedScreen(previews = true),
    ReturnToTheRoutinesTab(previews = false),
    // The routines home has nothing behind it, so back is the platform's and leaves the app.
    LeaveTheApp(previews = false),
}

// What fills the room's frame. Each carries the tab it stands over, so a move between tabs fades
// through and a move along one tab's stack travels by depth.
internal sealed interface Frame {
    val tab: Tab
    val key: String
    val depth: Int

    // Coach keeps the full three-tab rail while reading a selected chat; every other pushed screen,
    // the logger and the editor own the whole frame.
    val railStands: Boolean
        get() = this is Root || this is Pushed && (away is Away.Coach || away is Away.Thread)

    data class Root(override val tab: Tab) : Frame {
        override val key get() = "tab:${tab.name}"
        override val depth get() = 0
    }

    data class Workout(override val tab: Tab) : Frame {
        override val key get() = "workout"
        override val depth get() = 1
    }

    // `under` is the entry the way back leads to; null is the tab, or the logger, beneath the stack.
    data class Pushed(override val tab: Tab, val away: Away, val position: Int, val under: Away?) : Frame {
        override val key get() = "away:$position:${away.key}"
        override val depth get() = 1 + position
    }

    data class Draft(override val tab: Tab) : Frame {
        override val key get() = "draft"
        override val depth get() = Int.MAX_VALUE
    }
}

// Where the room stands: the navigator's tab and stack, and the two things above them that the
// room owns — a routine draft and the visible logger.
internal data class Standing(val tab: Tab, val away: List<Away>, val building: Boolean, val logger: Boolean) {
    val means: BackMeans
        get() = when {
            logger && !building && away.isEmpty() -> BackMeans.HideTheWorkout
            building -> BackMeans.LeaveTheDraft
            away.isNotEmpty() -> BackMeans.PopOnePushedScreen
            tab != Tab.Routines -> BackMeans.ReturnToTheRoutinesTab
            else -> BackMeans.LeaveTheApp
        }

    // What stands is what a back would leave.
    val frame: Frame
        get() = when (means) {
            BackMeans.HideTheWorkout -> Frame.Workout(tab)
            BackMeans.LeaveTheDraft -> Frame.Draft(tab)
            BackMeans.PopOnePushedScreen -> Frame.Pushed(tab, away.last(), away.size, away.getOrNull(away.size - 2))
            BackMeans.ReturnToTheRoutinesTab, BackMeans.LeaveTheApp -> Frame.Root(tab)
        }

    // Where a back leaves the room; null when back is the platform's.
    fun afterBack(): Standing? = when (means) {
        BackMeans.HideTheWorkout -> copy(logger = false)
        BackMeans.LeaveTheDraft -> copy(building = false)
        BackMeans.PopOnePushedScreen -> copy(away = away.dropLast(1))
        BackMeans.ReturnToTheRoutinesTab -> copy(tab = Tab.Routines)
        BackMeans.LeaveTheApp -> null
    }
}

// A screen holding work that back would lose registers a guard. While one is enabled, back previews
// nothing and asks that screen instead of leaving. A screen holding typed entry registers a keeper
// instead: back keeps what is typed, then leaves.
@Stable
internal class BackGuards {
    internal class Guard(val ask: () -> Unit) {
        var enabled by mutableStateOf(false)
    }

    internal class Keeper(val keep: () -> Unit)

    private val held = mutableStateListOf<Guard>()
    private val keepers = mutableListOf<Keeper>()
    val active: Guard? get() = held.lastOrNull { it.enabled }

    fun hold(guard: Guard) { held += guard }
    fun release(guard: Guard) { held -= guard }
    fun hold(keeper: Keeper) { keepers += keeper }
    fun release(keeper: Keeper) { keepers -= keeper }
    fun keepTyped() = keepers.toList().forEach { it.keep() }
}

internal val LocalBackGuards = staticCompositionLocalOf { BackGuards() }

// Whether the frame drawing this is the one standing. A frame sliding away, or one a gesture reveals
// beneath, asks nothing: a back belongs to what stands.
internal val LocalFrameStands = compositionLocalOf { true }

@Composable
internal fun KeepOnBack(keep: () -> Unit) {
    val guards = LocalBackGuards.current
    val currentKeep by rememberUpdatedState(keep)
    val keeper = remember { BackGuards.Keeper { currentKeep() } }
    DisposableEffect(guards, keeper) {
        guards.hold(keeper)
        onDispose { guards.release(keeper) }
    }
}

@Composable
internal fun BackGuard(enabled: Boolean, ask: () -> Unit) {
    val guards = LocalBackGuards.current
    val stands = LocalFrameStands.current
    val currentAsk by rememberUpdatedState(ask)
    val guard = remember { BackGuards.Guard { currentAsk() } }
    SideEffect { guard.enabled = enabled && stands }
    DisposableEffect(guards, guard) {
        guards.hold(guard)
        onDispose { guards.release(guard) }
    }
}

// The room's navigation: which tab is open and the screens pushed over it. What a back means is a
// rule of `Standing`, read off this and the room's own draft and logger.
@Stable
internal class GymNavigator(tab: Tab = Tab.Routines, away: List<Away> = emptyList()) {
    var tab by mutableStateOf(tab)
        private set
    var away by mutableStateOf(away)
        private set
    val guards = BackGuards()

    fun push(at: Away) { away = away + at }
    fun pop() { away = away.dropLast(1) }
    fun reset(to: List<Away> = emptyList()) { away = to }
    fun choose(next: Tab) { tab = next }
    fun standing(building: Boolean, logger: Boolean) = Standing(tab, away, building, logger)

    companion object {
        fun saver(telemetry: Telemetry): Saver<GymNavigator, Any> {
            val stack = awaySaver(telemetry)
            return listSaver(
                save = { listOf(with(tabSaver) { save(it.tab) }, with(stack) { save(it.away) }) },
                restore = { GymNavigator(restoredTab(it[0]), (it[1] as? String)?.let(stack::restore).orEmpty()) },
            )
        }
    }
}

@Composable
internal fun rememberGymNavigator(telemetry: Telemetry): GymNavigator =
    rememberSaveable(saver = remember(telemetry) { GymNavigator.saver(telemetry) }) { GymNavigator() }

// A back gesture over the frame: how far it has come, the edge it started from, and the frame it is
// shrinking. One gesture holds it from its first event until it settles; a back that lands meanwhile
// waits, and a write from a gesture that no longer holds it is dropped.
@Stable
private class BackGesture {
    enum class Phase { Idle, Previewing, Releasing, Settling }

    val progress = Animatable(0f)
    val release = Animatable(0f)
    var phase by mutableStateOf(Phase.Idle)
        private set
    var shrinking by mutableStateOf<String?>(null)
        private set
    var fromLeft by mutableStateOf(true)
        private set
    private var turn = 0

    suspend fun awaitIdle() {
        snapshotFlow { phase }.first { it == Phase.Idle }
    }

    fun begin(frame: Frame, edge: Int): Int {
        shrinking = frame.key
        fromLeft = edge == BackEventCompat.EDGE_LEFT
        phase = Phase.Previewing
        return ++turn
    }

    fun releasing(held: Int) {
        if (held == turn) phase = Phase.Releasing
    }

    fun settle(held: Int) {
        if (held == turn) phase = Phase.Settling
    }

    suspend fun reset() {
        progress.snapTo(0f)
        release.snapTo(0f)
        shrinking = null
        phase = Phase.Idle
    }
}

// The room's frame as the navigator moves it. A push and a pop travel along the shared X axis, a tab
// change fades through, and a back gesture shrinks the standing frame toward 90 % over the frame its
// release returns to. With Remove animations on, each of these is a cut.
@Composable
internal fun GymStage(
    standing: Standing,
    guards: BackGuards,
    onBack: (BackMeans) -> Unit,
    content: @Composable (Frame) -> Unit,
) {
    val animate = animationsOn()
    val frame = standing.frame
    val gesture = remember { BackGesture() }
    val transition = remember { SeekableTransitionState(frame) }
    val scope = rememberCoroutineScope()
    val slidePx = with(LocalDensity.current) { NavigationMotion.sharedAxisSlide.roundToPx() }
    val latest by rememberUpdatedState(standing)
    val latestAnimate by rememberUpdatedState(animate)
    val latestOnBack by rememberUpdatedState(onBack)

    LaunchedEffect(frame, gesture.phase) {
        when (gesture.phase) {
            BackGesture.Phase.Previewing, BackGesture.Phase.Releasing -> Unit
            BackGesture.Phase.Settling -> {
                transition.snapTo(frame)
                gesture.reset()
            }
            BackGesture.Phase.Idle -> if (animate) transition.animateTo(frame) else transition.snapTo(frame)
        }
    }

    PredictiveBackHandler(enabled = standing.means != BackMeans.LeaveTheApp || guards.active != null) { events ->
        gesture.awaitIdle()
        val at = latest
        val means = at.means
        val guard = guards.active
        val beneath = at.afterBack()?.frame
        val previews = latestAnimate && guard == null && means.previews && beneath != null
        var held: Int? = null
        try {
            events.collect { event ->
                if (!previews) return@collect
                if (held == null) {
                    held = gesture.begin(at.frame, event.swipeEdge)
                    transition.seekTo(0f, beneath!!)
                }
                gesture.progress.snapTo(NavigationMotion.backProgress(event.progress))
            }
        } catch (cancelled: CancellationException) {
            held?.let { turn -> scope.launch {
                try { gesture.progress.animateTo(0f, tween(NavigationMotion.durationMs / 2, easing = NavigationMotion.emphasized)) }
                finally { gesture.settle(turn) }
            } }
            throw cancelled
        }
        if (guard != null) {
            guard.ask()
            return@PredictiveBackHandler
        }
        val turn = held
        if (turn == null) {
            guards.keepTyped()
            latestOnBack(means)
            return@PredictiveBackHandler
        }
        gesture.releasing(turn)
        // A second back cancels the release animation, never the pop it committed to.
        try { gesture.release.animateTo(1f, tween(NavigationMotion.durationMs, easing = NavigationMotion.emphasizedAccelerate)) }
        finally {
            guards.keepTyped()
            latestOnBack(means)
            gesture.settle(turn)
        }
    }

    rememberTransition(transition).AnimatedContent(
        modifier = Modifier.fillMaxSize(),
        contentKey = { it.key },
        transitionSpec = {
            when {
                gesture.phase != BackGesture.Phase.Idle ->
                    (EnterTransition.None togetherWith ExitTransition.KeepUntilTransitionsFinished).behind()
                initialState.tab != targetState.tab -> NavigationMotion.fadeThrough()
                targetState.depth >= initialState.depth -> NavigationMotion.sharedAxisX(forward = true, slidePx)
                else -> NavigationMotion.sharedAxisX(forward = false, slidePx).behind()
            }
        },
    ) { shown ->
        Box(Modifier.fillMaxSize().graphicsLayer {
            if (shown.key != gesture.shrinking) return@graphicsLayer
            val progress = gesture.progress.value
            val scale = lerp(1f, NavigationMotion.backScale, progress)
            val toward = if (gesture.fromLeft) 1f else -1f
            scaleX = scale
            scaleY = scale
            translationX = toward * (NavigationMotion.backShift.toPx() * progress + gesture.release.value * size.width)
            shape = RoundedCornerShape(NavigationMotion.backCorner * progress)
            clip = true
            shadowElevation = 12.dp.toPx() * progress
        }) {
            CompositionLocalProvider(LocalBackGuards provides guards, LocalFrameStands provides (shown.key == frame.key)) {
                content(shown)
            }
        }
    }
}

// The frame a move returns to is drawn under the one leaving it.
private fun ContentTransform.behind(): ContentTransform = apply { targetContentZIndex = -1f }
