package works.windmill.gym.coach.turn

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.io.IOException
import java.util.Random
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import works.windmill.agent.TurnConnectionLost
import works.windmill.agent.TurnEvent
import works.windmill.agent.TurnOpen
import works.windmill.agent.TurnRefusal
import works.windmill.agent.TurnSeat
import works.windmill.agent.TurnTransport
import works.windmill.domain.kit.Catalog
import works.windmill.domain.kit.Id
import works.windmill.domain.kit.Outcome
import works.windmill.gym.coach.CoachAttachment
import works.windmill.gym.coach.CoachPhotos
import works.windmill.gym.domain.coach.CoachPictureRow
import works.windmill.gym.domain.coach.CoachThread
import works.windmill.gym.domain.coach.CoachTurnBounds
import works.windmill.gym.domain.coach.KeepPicture
import works.windmill.gym.domain.coach.Picture
import works.windmill.sync.core.Json
import works.windmill.sync.engine.discardDormant
import works.windmill.sync.engine.signIn
import works.windmill.sync.engine.signOut

// A picture at the bounds of Coach §9.3, and where its files go: after the commit of a withdrawal or a deletion, at a sweep once no retained replica names them, and never outside their folder.
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PictureFilesTests {
    @get:Rule val folder = TemporaryFolder()

    private val answers = """[{"event":"done","data":{"state":"completed"}}]"""

    private fun script(frames: String = answers) = ScriptedTurns(Json.parse(frames).arr())

    private fun noise(width: Int, height: Int): Bitmap {
        val random = Random(7)
        val pixels = IntArray(width * height) { Color.rgb(random.nextInt(256), random.nextInt(256), random.nextInt(256)) }
        return Bitmap.createBitmap(pixels, width, height, Bitmap.Config.ARGB_8888)
    }

    private fun small(id: String = "picture-1"): ChosenPicture {
        val bitmap = Bitmap.createBitmap(40, 30, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.RED) }
        val bytes = java.io.ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it) }.toByteArray()
        return ChosenPicture(CoachAttachment(id, "image/jpeg", 40, 30, bytes.size.toLong()), bytes)
    }

    @Test fun aPictureAtTheBoundsKeepsItsOriginalAndAModelCopyWithinTheModelBounds() {
        val source = File(folder.root, "source.jpg")
        val bitmap = noise(3_400, 2_600)
        source.outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG, 100, it)) }
        bitmap.recycle()
        val resolver = ApplicationProvider.getApplicationContext<android.content.Context>().contentResolver
        val (attachment, original) = CoachPhotos.read(resolver, Uri.fromFile(source))
        assertTrue("an original near PICTURE_BYTES: ${original.size}", original.size in 3 * 1024 * 1024..CoachPhotos.maxBytes)

        val directory = File(folder.root, "pictures")
        val pictures = PictureFiles { directory }
        val row = pictures.keep(ChosenPicture(attachment, original))

        assertEquals(CoachPictureRow(attachment.id, attachment.mediaType, attachment.width, attachment.height, original.size), row)
        assertArrayEquals(original, pictures.original(attachment.id)!!.readBytes())
        val model = pictures.model(attachment.id)!!
        assertTrue("the model copy holds within MODEL_PICTURE_BYTES: ${model.size}", model.size <= CoachTurnBounds.modelPictureBytes)
        assertTrue("a model copy takes the room it has: ${model.size}", model.size > CoachTurnBounds.modelPictureBytes / 4)
        val decoded = checkNotNull(BitmapFactory.decodeByteArray(model, 0, model.size))
        assertTrue(maxOf(decoded.width, decoded.height) <= CoachTurnBounds.modelPictureEdge)
        assertEquals(0xFF.toByte(), model[0])
        assertEquals(0xD8.toByte(), model[1])
        assertEquals(setOf(attachment.id), pictures.held())
        assertEquals(listOf("${attachment.id}.model", "${attachment.id}.original"), directory.list()!!.sorted())
    }

    @Test fun aLargePictureTakesTheFullModelEdgeAndATransparentOneLandsOnWhite() {
        val directory = File(folder.root, "pictures")
        val pictures = PictureFiles { directory }
        val plain = Bitmap.createBitmap(3_200, 1_600, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.TRANSPARENT) }
        val png = java.io.ByteArrayOutputStream().also { plain.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        pictures.keep(ChosenPicture(CoachAttachment("picture-png", "image/png", 3_200, 1_600, png.size.toLong()), png))
        val model = pictures.model("picture-png")!!
        val decoded = checkNotNull(BitmapFactory.decodeByteArray(model, 0, model.size))
        assertEquals(1_568, decoded.width)
        assertEquals(784, decoded.height)
        assertEquals(Color.WHITE, decoded.getPixel(10, 10))
    }

    @Test fun aModelCopyIsMadeOnce() {
        val pictures = PictureFiles { File(folder.root, "pictures") }
        pictures.keep(small())
        val first = pictures.model("picture-1")!!
        val other = Bitmap.createBitmap(40, 30, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.BLUE) }
        val bytes = java.io.ByteArrayOutputStream().also { other.compress(Bitmap.CompressFormat.JPEG, 90, it) }.toByteArray()
        pictures.keep(ChosenPicture(CoachAttachment("picture-1", "image/jpeg", 40, 30, bytes.size.toLong()), bytes))
        assertArrayEquals(first, pictures.model("picture-1"))
    }

    @Test fun aPictureIdThatIsNotAPlainNameNamesNoFile() {
        val directory = File(folder.root, "pictures").apply { mkdirs() }
        val outside = File(folder.root, "outside.original").apply { writeText("kept") }
        val pictures = PictureFiles { directory }
        assertNull(pictures.model("../outside"))
        assertNull(pictures.original("../outside"))
        pictures.delete(listOf("../outside", "a/b/c/d/e", ""))
        assertEquals("kept", outside.readText())
        try {
            pictures.keep(ChosenPicture(CoachAttachment("../outside", "image/jpeg", 40, 30, 1), byteArrayOf(1)))
            throw AssertionError("A picture kept under a path")
        } catch (expected: IOException) {
            assertEquals("kept", outside.readText())
        }
    }

    // §4.1 step 5, §9.3: a picture leaves only as its model copy inside the open request, the message says it stays on this phone, and the next turn carries the one before it.
    @Test fun anOpenCarriesTheModelCopiesOfThisMessageAndTheOneBefore() = runTest {
        TurnPhone(this, folder.newFolder(), script("""[{"event":"done","data":{"state":"completed"}}]""")).use { phone ->
            val first = checkNotNull(phone.turns.send("Look at this", small("picture-1"), null, anonymous = true))
            advanceUntilIdle()
            assertEquals(listOf(Picture("picture-1", "image/jpeg", localOnly = true)), phone.message(first.lifter)?.pictures)
            assertEquals(CoachPictureRow("picture-1", "image/jpeg", 40, 30, small().original.size), CoachPictureRow.decode("picture-1", phone.device(CoachPictureRow.key("picture-1"))))
            val opened = phone.server.opened.single()
            assertEquals(listOf("picture-1"), opened.pictures.map { it.id })
            assertEquals(listOf("image/jpeg"), opened.pictures.map { it.mediaType })
            assertArrayEquals(phone.pictures.model("picture-1"), opened.pictures.single().data)
        }
        val server = script()
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            val first = checkNotNull(phone.turns.send("One", small("picture-1"), null, anonymous = true))
            advanceUntilIdle()
            phone.room.now += 1_000
            server.rewind()
            checkNotNull(phone.turns.send("Two", small("picture-2"), first.thread, anonymous = true))
            advanceUntilIdle()
            assertEquals(listOf(listOf("picture-1"), listOf("picture-2", "picture-1")), server.opened.map { open -> open.pictures.map { it.id } })
        }
    }

    // The turn goes, its files with it, and what the lifter sent returns: the picture itself, and no conversation that went too.
    @Test fun aWithdrawnTurnTakesItsPictureFilesAndReturnsWhatWasSent() = runTest {
        val server = script("[]").apply { refuseOpen = TurnRefusal(429, "subject_exhausted", null) }
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            val picture = small()
            checkNotNull(phone.turns.send("Look at this", picture, null, anonymous = true))
            advanceUntilIdle()
            assertEquals(CoachTurnRefusal.Allowance("subject_exhausted"), phone.turns.refusal.value)
            assertEquals(WithdrawnTurn("Look at this", picture, null), phone.turns.withdrawn.value)
            assertEquals(emptyList<Any>(), phone.messages())
            assertEquals(emptyList<Any>(), phone.threads())
            assertNull(phone.device(CoachPictureRow.key("picture-1")))
            assertEquals(emptySet<String>(), phone.pictures.held())
            assertEquals(emptyList<String>(), phone.pictureFolder.list()!!.toList())

            server.refuseOpen = null
            val back = checkNotNull(phone.turns.withdrawn.value)
            assertTrue(phone.turns.send(back.question, back.picture, back.thread, anonymous = true) != null)
            advanceUntilIdle()
            assertEquals(setOf("picture-1"), phone.pictures.held())
            assertNull(phone.turns.withdrawn.value)
        }
    }

    // An open every attempt lost takes the picture back the same way, and asking again carries it.
    @Test fun anOpenEveryAttemptLostReturnsThePicture() = runTest {
        val server = script("""[{"event":"done","data":{"state":"completed"}}]""")
        var reachable = false
        val flaky = object : TurnTransport by server {
            override fun open(open: TurnOpen, seat: TurnSeat): Flow<TurnEvent> = if (reachable) server.open(open, seat) else flow { throw TurnConnectionLost(null) }
        }
        TurnPhone(this, folder.newFolder(), flaky).use { phone ->
            val picture = small()
            checkNotNull(phone.turns.send("Look at this", picture, null, anonymous = true))
            advanceUntilIdle()
            assertEquals(CoachTurnRefusal.Offline, phone.turns.refusal.value)
            assertEquals(WithdrawnTurn("Look at this", picture, null), phone.turns.withdrawn.value)
            assertEquals(emptyList<Any>(), phone.messages())
            assertNull(phone.device(CoachPictureRow.key("picture-1")))
            assertEquals(emptySet<String>(), phone.pictures.held())

            reachable = true
            val back = checkNotNull(phone.turns.withdrawn.value)
            assertTrue(phone.turns.send(back.question, back.picture, back.thread, anonymous = true) != null)
            advanceUntilIdle()
            assertEquals(listOf(listOf("picture-1")), server.opened.map { open -> open.pictures.map { it.id } })
            assertNull(phone.turns.withdrawn.value)
        }
    }

    // A refused open leaves nothing: not the row it kept a moment before, and not the files.
    @Test fun aRefusedOpenLeavesItsPictureBehindNowhere() = runTest {
        TurnPhone(this, folder.newFolder(), script()).use { phone ->
            assertNull(phone.turns.send("Look at this", small(), Id("thrdNobody000000", CoachThread), anonymous = true))
            advanceUntilIdle()
            assertEquals(CoachTurnFault.unsaved, phone.turns.fault.value)
            assertNull(phone.device(CoachPictureRow.key("picture-1")))
            assertEquals(emptyList<String>(), phone.pictureFolder.list()?.toList().orEmpty())
            assertEquals(emptyList<Any>(), phone.messages())
        }
    }

    // A discard decision takes a running turn: its stream is stopped, its messages go with the replica's work, and so do its files.
    @Test fun aDiscardDecisionTakesTheRunningTurnAndItsFiles() = runTest {
        TurnPhone(this, folder.newFolder(), script("""[{"await":"stop"},{"event":"done","data":{"state":"stopped"}}]""")).use { phone ->
            phone.turns.start()
            advanceUntilIdle()
            checkNotNull(phone.turns.send("Look at this", small(), null, anonymous = true))
            advanceUntilIdle()
            val question = phone.engine.signIn("account-1", mapOf("gym" to true))
            val pins = question.member("due").arr().associate { due -> due.member("product").str() to due.member("counted").arr().map(Json::str) }
            assertTrue(phone.engine.signIn("account-1", mapOf("gym" to true), mapOf("gym" to "discard"), pins).member("complete").bool())
            advanceUntilIdle()
            assertNull(phone.turns.turn.value)
            assertEquals(1, phone.server.stops)
            assertEquals(emptyList<Any>(), phone.messages())
            assertEquals(emptySet<String>(), phone.pictures.held())
            assertEquals(listOf("seat_changed"), phone.telling.named("coach_turn").map { it["code"] })
            assertEquals(emptyList<Map<String, String>>(), phone.telling.failures)
        }
    }

    @Test fun aDeletedConversationTakesItsPictureFilesAndARunningOneStays() = runTest {
        TurnPhone(this, folder.newFolder(), script("""[{"await":"stop"},{"event":"done","data":{"state":"stopped"}}]""")).use { phone ->
            val turn = checkNotNull(phone.turns.send("Look at this", small(), null, anonymous = true))
            advanceUntilIdle()
            assertFalse(phone.turns.deleteConversation(turn.thread))
            assertEquals(setOf("picture-1"), phone.pictures.held())
            phone.turns.requestStop()
            advanceUntilIdle()
            assertTrue(phone.turns.deleteConversation(turn.thread))
            assertEquals(emptyList<Any>(), phone.messages())
            assertEquals(emptyList<Any>(), phone.threads())
            assertNull(phone.device(CoachPictureRow.key("picture-1")))
            assertEquals(emptySet<String>(), phone.pictures.held())
        }
    }

    // What a dead process left: a file with no row, and a row with no message. A retained replica's row keeps its file.
    @Test fun aSweepTakesOrphansAndLeavesWhatARetainedReplicaNames() = runTest {
        TurnPhone(this, folder.newFolder(), script()).use { phone ->
            val turn = checkNotNull(phone.turns.send("Mine", small("picture-kept"), null, anonymous = true))
            advanceUntilIdle()
            val row = phone.pictures.keep(small("picture-row"))
            val replica = phone.engine.activeReplica()
            phone.room.training.pinnedOn(replica, true) { runner -> assertTrue(runner.run(KeepPicture(row)) is Outcome.Committed) }
            phone.pictures.keep(small("picture-loose"))
            File(phone.pictureFolder, "picture-torn.original.tmp").writeText("half")

            phone.turns.start()
            advanceUntilIdle()
            assertEquals(setOf("picture-kept"), phone.pictures.held())
            assertNull(phone.device(CoachPictureRow.key("picture-row")))
            assertEquals(listOf(Picture("picture-kept", "image/jpeg", localOnly = true)), phone.message(turn.lifter)?.pictures)
        }
    }

    @Test fun aReplicaKeptDormantHoldsItsFilesAndDiscardingItFreesThem() = runTest {
        TurnPhone(this, folder.newFolder(), script()).use { phone ->
            phone.signIn()
            phone.turns.start()
            advanceUntilIdle()
            checkNotNull(phone.turns.send("Mine", small("picture-kept"), null, anonymous = false))
            advanceUntilIdle()
            assertTrue(phone.engine.signOut("keep").member("complete").bool())
            advanceUntilIdle()
            assertEquals(setOf("picture-kept"), phone.pictures.held())

            phone.turns.sweep()
            advanceUntilIdle()
            assertEquals(setOf("picture-kept"), phone.pictures.held())

            assertTrue(phone.engine.discardDormant("account-1"))
            phone.turns.sweep()
            advanceUntilIdle()
            assertEquals(emptySet<String>(), phone.pictures.held())
        }
    }

    @Test fun aSignOutThatDiscardsFreesItsFilesWhenTheReplicaChanges() = runTest {
        TurnPhone(this, folder.newFolder(), script()).use { phone ->
            phone.signIn()
            phone.turns.start()
            advanceUntilIdle()
            checkNotNull(phone.turns.send("Mine", small("picture-gone"), null, anonymous = false))
            advanceUntilIdle()
            assertEquals(setOf("picture-gone"), phone.pictures.held())
            val question = phone.engine.signOut()
            assertTrue(phone.engine.signOut("discard", question.member("counted").arr().map { it.str() }).member("complete").bool())
            advanceUntilIdle()
            assertEquals(emptySet<String>(), phone.pictures.held())
        }
    }

    // Account deletion's sweep runs while the account still reads as in transition: what the discard left goes all the same.
    @Test fun aSweepTakesTheFilesADiscardLeftWhileTheAccountIsInTransition() = runTest {
        var writable = true
        TurnPhone(this, folder.newFolder(), script(), writable = { writable }).use { phone ->
            phone.signIn()
            checkNotNull(phone.turns.send("Mine", small("picture-gone"), null, anonymous = false))
            advanceUntilIdle()
            assertTrue(phone.engine.signOut("keep").member("complete").bool())
            writable = false
            assertTrue(phone.engine.discardDormant("account-1"))
            phone.turns.sweep()
            advanceUntilIdle()
            assertEquals(emptySet<String>(), phone.pictures.held())
        }
    }

    // A replica behind its log cannot tell a message gone from one on its way, so a row it cannot match stays.
    @Test fun aReplicaBehindItsLogForgetsNoRow() = runTest {
        TurnPhone(this, folder.newFolder(), script()).use { phone ->
            phone.signIn()
            val row = phone.pictures.keep(small("picture-row"))
            val replica = phone.engine.activeReplica()
            phone.room.training.pinnedOn(replica, false) { runner -> assertTrue(runner.run(KeepPicture(row)) is Outcome.Committed) }
            assertTrue(phone.engine.signOut("keep").member("complete").bool())
            assertTrue(phone.engine.signIn("account-1", mapOf("gym" to true)).member("complete").bool())
            phone.turns.sweep()
            advanceUntilIdle()
            assertEquals(setOf("picture-row"), phone.pictures.held())
            assertEquals(row.json, phone.device(CoachPictureRow.key("picture-row")))
        }
    }

    @Test fun theCatalogLandsInTheAssetsAsTheContractsOwnFile() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val asset = context.assets.open("gym-catalog.json").use { it.readBytes() }
        assertArrayEquals(File(System.getProperty("windmill.contract"), "gym/catalog.json").readBytes(), asset)
        assertEquals("catalog/2", Catalog(Json.parse(asset)).version)
    }
}
