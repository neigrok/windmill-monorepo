package works.windmill.gym.ui.onboarding

import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import works.windmill.gym.R
import works.windmill.gym.ui.GymSkin
import works.windmill.platform.design.LocalWindmillDark
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.telemetry.LocalTelemetry

private val titles = listOf(R.string.onboarding_title_windmill, R.string.onboarding_title_roadmap,
    R.string.onboarding_title_journal, R.string.onboarding_title_gym)
private val bodies = listOf(R.string.onboarding_body_windmill, R.string.onboarding_body_roadmap,
    R.string.onboarding_body_journal, R.string.onboarding_body_gym)
private val locations = listOf(null, R.string.onboarding_roadmap_where,
    R.string.onboarding_journal_where, R.string.onboarding_gym_where)
private val examples = listOf(R.string.onboarding_example_windmill, R.string.onboarding_example_roadmap,
    R.string.onboarding_example_journal, R.string.onboarding_example_gym)
private val screens = listOf("windmill", "roadmap", "journal", "gym")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OnboardingPager(replay: Boolean, onExit: () -> Unit, reducedMotion: Boolean? = null,
    onPageSettled: (Int) -> Unit = {}) {
    val dark = LocalWindmillDark.current
    val skin = if (dark) GymSkin.Instrument else GymSkin.Daylight
    val accent = if (dark) skin.accent else Color(0xFF137A6C)
    val telemetry = LocalTelemetry.current
    val state = if (replay) "replay" else "first_launch"
    val pager = rememberPagerState { 4 }
    val scope = rememberCoroutineScope()
    val systemReduced = onboardingReducedMotion()
    val reduced = reducedMotion ?: systemReduced
    var requestedPage by remember { mutableStateOf<Int?>(null) }
    var backPreview by remember { mutableStateOf(false) }
    var previousPage by rememberSaveable { mutableIntStateOf(pager.settledPage) }
    var viewedPage by rememberSaveable { mutableIntStateOf(-1) }
    var opened by rememberSaveable { mutableStateOf(false) }
    val currentExit by rememberUpdatedState(onExit)
    val currentPageSettled by rememberUpdatedState(onPageSettled)
    fun exit(outcome: String) {
        telemetry.event("onboarding_exited", mapOf("state" to state, "screen" to screens[pager.settledPage], "outcome" to outcome))
        currentExit()
    }
    fun move(page: Int, action: String) {
        if (pager.isScrollInProgress || page !in 0..3 || page == pager.currentPage) return
        requestedPage = page
        val start = pager.currentPage
        telemetry.event("onboarding_action", mapOf("state" to state, "screen" to screens[pager.settledPage], "action" to action))
        scope.launch {
            try {
                if (reduced) pager.scrollToPage(page) else pager.animateScrollToPage(page)
            } finally {
                if (pager.settledPage == start) requestedPage = null
            }
        }
    }
    LaunchedEffect(Unit) {
        if (!opened) { telemetry.event("onboarding_opened", mapOf("state" to state)); opened = true }
    }
    LaunchedEffect(pager.settledPage, backPreview) {
        if (backPreview) return@LaunchedEffect
        val page = pager.settledPage
        currentPageSettled(page)
        if (page == viewedPage) return@LaunchedEffect
        if (page != previousPage && requestedPage != page) {
            telemetry.event("onboarding_action", mapOf("state" to state, "screen" to screens[previousPage], "action" to "swipe"))
        }
        requestedPage = null
        previousPage = page
        viewedPage = page
        telemetry.event("onboarding_page_viewed", mapOf("state" to state, "screen" to screens[page]))
    }
    PredictiveBackHandler(enabled = replay || pager.settledPage > 0 || backPreview) { events ->
        val start = pager.currentPage
        var progress = 0f
        try {
            backPreview = true
            requestedPage = start - 1
            pager.scroll {
                events.collect { event ->
                    if (start > 0 && !reduced) {
                        scrollBy(-(event.progress - progress) * pager.layoutInfo.pageSize)
                        progress = event.progress
                    }
                }
            }
            if (start == 0) exit("back") else {
                telemetry.event("onboarding_action", mapOf("state" to state, "screen" to screens[start], "action" to "back"))
                if (reduced) pager.scrollToPage(start - 1) else pager.animateScrollToPage(start - 1)
            }
        } catch (cancelled: CancellationException) {
            withContext(NonCancellable) { pager.scrollToPage(start) }
            requestedPage = null
            throw cancelled
        } finally {
            backPreview = false
        }
    }
    Column(Modifier.fillMaxSize().background(skin.canvas).safeDrawingPadding()
        .semantics { isTraversalGroup = true }.testTag("onboarding")) {
        TopAppBar(
            title = {
                if (pager.currentPage == 0) {
                    val brand = stringResource(R.string.onboarding_brand)
                    val density = LocalDensity.current
                    CompositionLocalProvider(LocalDensity provides Density(density.density, 1f)) {
                    Row(Modifier.padding(start = 4.dp).clearAndSetSemantics { contentDescription = brand; traversalIndex = -1f },
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Image(painterResource(R.drawable.onboarding_brand_mark), null, Modifier.size(42.45.dp, 44.dp))
                    Text(stringResource(R.string.onboarding_brand), color = Color(0xFFD08A5E),
                        style = TextStyle(fontFamily = FontFamily(Font(R.font.onboarding_baloo_bold, FontWeight.Bold)),
                            fontWeight = FontWeight.Bold, fontSize = 30.sp, lineHeight = 36.sp))
                }
                    }
                }
            },
            navigationIcon = {
                if (replay) TextButton(onClick = { exit("closed") }, modifier = Modifier.semantics { traversalIndex = -2f }) {
                    Text("‹", color = accent, fontSize = 32.sp, modifier = Modifier.clearAndSetSemantics { })
                    Text(stringResource(R.string.onboarding_back), color = accent,
                        style = MaterialTheme.typography.labelLarge.copy(lineHeight = 22.sp))
                }
            },
            actions = {
                if (!replay && pager.currentPage < 3) TextButton(onClick = { exit("skipped") },
                    modifier = Modifier.semantics { traversalIndex = 0f }) {
                    Text(stringResource(R.string.onboarding_skip), color = accent,
                        style = MaterialTheme.typography.labelLarge.copy(lineHeight = 22.sp))
                }
            },
            expandedHeight = 64.dp,
            windowInsets = WindowInsets(0, 0, 0, 0),
            colors = TopAppBarDefaults.topAppBarColors(containerColor = skin.canvas),
        )
        HorizontalPager(pager, Modifier.weight(1f).fillMaxWidth().semantics { isTraversalGroup = false },
            key = { it }) { page ->
            val active = page == pager.settledPage && !pager.isScrollInProgress
            val scroll = rememberScrollState()
            Column(Modifier.fillMaxSize().verticalScroll(scroll, enabled = scroll.maxValue > 0)
                .testTag("onboarding_page_$page")
                .padding(horizontal = 20.dp).padding(top = 12.dp, bottom = 16.dp)
                .semantics { isTraversalGroup = false; if (page != pager.currentPage) hideFromAccessibility() },
                horizontalAlignment = Alignment.CenterHorizontally) {
                val example = stringResource(examples[page])
                val largeType = LocalDensity.current.fontScale >= 1.5f
                Box(Modifier.widthIn(max = 354.dp).fillMaxWidth()
                    .height(if (largeType) 260.dp else if (page == 0) 320.dp else 340.dp)
                    .clearAndSetSemantics { contentDescription = example; traversalIndex = 5f }
                    .testTag("onboarding_glimpse")) {
                    OnboardingGlimpse(page, active, reduced, Modifier.fillMaxSize())
                }
                Spacer(Modifier.height(28.dp))
                Column(Modifier.fillMaxWidth().semantics { isTraversalGroup = false }, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (page > 0) Row(Modifier.semantics(mergeDescendants = true) { traversalIndex = 1f },
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Box(Modifier.size(7.dp).background(when (page) {
                            1 -> Color(0xFFD08A5E); 2 -> if (dark) Color(0xFFE0B972) else Color(0xFF986B1E); else -> accent
                        }, CircleShape))
                        Text(screens[page].uppercase(), color = skin.inkDim,
                            style = WindmillFont.mono(11, FontWeight.Medium).copy(lineHeight = 16.sp, letterSpacing = 2.2.sp))
                    }
                    Text(stringResource(titles[page]), color = skin.ink,
                        style = MaterialTheme.typography.headlineLarge.copy(lineHeight = 38.sp),
                        modifier = Modifier.semantics { heading(); traversalIndex = 2f })
                    Text(stringResource(bodies[page]), color = skin.inkDim,
                        style = MaterialTheme.typography.bodyLarge.copy(lineHeight = 24.sp),
                        modifier = Modifier.semantics { traversalIndex = 3f })
                    locations[page]?.let { location ->
                        Text(stringResource(location), color = if (page == 3) accent else skin.inkDim,
                            style = MaterialTheme.typography.labelSmall.copy(lineHeight = 16.sp, letterSpacing = .1.sp),
                            modifier = Modifier.background(if (page == 3) accent.copy(alpha = .12f) else skin.raised, CircleShape)
                                .border(1.dp, if (page == 3) accent else if (dark) skin.lineStrong else skin.line, CircleShape)
                                .padding(horizontal = 10.dp, vertical = 5.dp).semantics { traversalIndex = 4f })
                    }
                }
            }
        }
        val pageLabel = stringResource(R.string.onboarding_page, pager.settledPage + 1)
        val previousLabel = stringResource(R.string.onboarding_previous_page)
        val nextLabel = stringResource(R.string.onboarding_next_page)
        Row(Modifier.align(Alignment.CenterHorizontally).height(44.dp).width(80.dp)
            .testTag("onboarding_pages").semantics {
                traversalIndex = 6f
                contentDescription = pageLabel
                progressBarRangeInfo = ProgressBarRangeInfo(pager.settledPage.toFloat(), 0f..3f, 2)
                setProgress { value -> move(value.toInt().coerceIn(0, 3), "adjust"); true }
                customActions = buildList {
                    if (pager.currentPage > 0) add(CustomAccessibilityAction(previousLabel) { move(pager.currentPage - 1, "adjust"); true })
                    if (pager.currentPage < 3) add(CustomAccessibilityAction(nextLabel) { move(pager.currentPage + 1, "adjust"); true })
                }
            }, horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
            repeat(4) { index ->
                Box(Modifier.size(8.dp).background(if (index == pager.settledPage) skin.ink else skin.inkFaint.copy(alpha = .55f), CircleShape))
            }
        }
        Button(onClick = { if (pager.currentPage < 3) move(pager.currentPage + 1, "next") else exit("completed") },
            enabled = !pager.isScrollInProgress,
            modifier = Modifier.padding(horizontal = 20.dp).padding(top = 12.dp, bottom = 16.dp).fillMaxWidth()
                .heightIn(min = 56.dp).semantics { traversalIndex = 7f },
            shape = RoundedCornerShape(16.dp), contentPadding = PaddingValues(horizontal = 24.dp, vertical = 16.dp),
            colors = ButtonDefaults.buttonColors(containerColor = accent, contentColor = skin.onAccent)) {
            Text(stringResource(if (pager.currentPage < 3) R.string.onboarding_next else if (replay) R.string.onboarding_done else R.string.onboarding_start),
                style = MaterialTheme.typography.labelLarge.copy(lineHeight = 22.sp))
        }
    }
}

@Composable
private fun onboardingReducedMotion(): Boolean {
    val resolver = LocalContext.current.contentResolver
    val telemetry = LocalTelemetry.current
    fun read(): Boolean = try {
        Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    } catch (error: Exception) {
        telemetry.failure("onboarding_motion_settings", error)
        true
    }
    var reduced by remember(resolver) { mutableStateOf(read()) }
    DisposableEffect(resolver) {
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) { reduced = read() }
        }
        val registered = try {
            resolver.registerContentObserver(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), false, observer)
            true
        } catch (error: Exception) {
            telemetry.failure("onboarding_motion_settings", error)
            reduced = true
            false
        }
        onDispose {
            if (registered) try {
                resolver.unregisterContentObserver(observer)
            } catch (error: Exception) {
                telemetry.failure("onboarding_motion_settings", error)
            }
        }
    }
    return reduced
}
