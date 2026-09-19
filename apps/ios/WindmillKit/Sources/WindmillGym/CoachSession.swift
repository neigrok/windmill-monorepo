import Foundation
import Combine
import WindmillPlatform

@MainActor
final class CoachSession: ObservableObject {
    @Published var conversation = AskConversation()
    @Published private(set) var photo: CoachPhotoDraft?
    @Published private(set) var photoData: Data?
    @Published private(set) var photoBusy = false
    @Published private(set) var uploadProgress: Double?
    @Published private(set) var photoFailure: String?
    @Published private(set) var user: String?

    private let requests: CoachRequests
    private let connection: (Account) -> any CoachServing
    private var api: (any CoachServing)?
    private var responseTask: Task<Void, Never>?
    private var photoTask: Task<Void, Never>?
    private var visit = UUID()

    init(requests: CoachRequests? = nil,
         connection: @escaping (Account) -> any CoachServing = { GymApi(api: $0.api) }) {
        self.requests = requests ?? CoachRequests()
        self.connection = connection
    }

    func connect(_ account: Account) async {
        responseTask?.cancel()
        photoTask?.cancel()
        user = account.user?.id
        api = connection(account)
        newView()
        guard let user else { return }
        await resume(requests.seat(user).thread)
    }

    func saveDraft() {
        guard let user else { return }
        do { try requests.select(conversation.threadId, user: user, draft: conversation.draft) }
        catch { conversation.historyFailure = "This draft could not be saved on this device." }
    }

    func resume(_ thread: String) async {
        guard let user else { return }
        newView(thread: thread)
        let visit = visit
        let seat = requests.seat(user)
        conversation.draft = seat.drafts[thread] ?? ""
        photo = seat.photos?[thread]
        if let photo { photoData = try? requests.photoData(photo.id, thread: thread, user: user) }
        saveDraft()
        if let request = seat.requests[thread] {
            conversation.exchanges = [AskExchange(id: request.requestId, question: request.question,
                outcome: .refused(AskRefusal(line: "Check this message to continue.", mayRetry: true)),
                attachments: photo.map { [$0.attachment] } ?? [])]
        }
        await load()
        guard self.user == user, self.visit == visit, !conversation.waiting, photo != nil else { return }
        uploadPhoto()
    }

    func newChat() {
        newView()
        saveDraft()
    }

    private func newView(thread: String = Ask.mintThreadId()) {
        responseTask?.cancel()
        photoTask?.cancel()
        visit = UUID()
        conversation = AskConversation(threadId: thread)
        photo = nil
        photoData = nil
        photoBusy = false
        uploadProgress = nil
        photoFailure = nil
    }

    func ask(_ draft: String, replacing id: String?) {
        guard !conversation.waiting, !conversation.isLoading, !photoBusy, let user else { return }
        guard photo == nil || photo?.uploaded == true else { return }
        if id == nil, conversation.unresolved != nil { return }
        let question = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Ask.fits(question), !question.isEmpty || photo != nil || id != nil else { return }
        var next = conversation
        let requestId = next.open(question, replacing: id)
        let retained = requests.seat(user).requests[next.threadId]
        let request: CoachRequest
        if let retained, retained.requestId == requestId {
            request = retained
        } else {
            let attachments = id.flatMap { known in next.exchanges.first { $0.id == known }?.attachments }
                ?? photo.map { [$0.attachment] } ?? []
            request = CoachRequest(thread: next.threadId, question: question, requestId: requestId,
                                   attachmentIds: attachments.isEmpty ? nil : attachments.map(\.id))
        }
        do { try requests.save(request, user: user, clearDraft: id == nil) }
        catch {
            conversation.historyFailure = "This message could not be saved on this device. Try again."
            return
        }
        if let photo, let index = next.exchanges.firstIndex(where: { $0.id == requestId }) {
            next.exchanges[index].attachments = [photo.attachment]
        }
        if id == nil { next.draft = "" }
        conversation = next
        send(request)
    }

    private func send(_ request: CoachRequest) {
        guard let user, let api else { return }
        responseTask?.cancel()
        let visit = visit
        responseTask = Task {
            for attempt in 0..<3 {
                do {
                    _ = try await api.streamCoach(request) { [weak self] generation in
                        guard let self, self.user == user, self.visit == visit else { throw CancellationError() }
                        self.conversation.accept(generation)
                        if generation.status == "completed" || generation.status == "stopped" {
                            try self.requests.resolve(request, user: user)
                            if self.photo?.id == request.attachmentIds?.first {
                                try self.requests.savePhoto(nil, thread: request.thread, user: user)
                                self.photo = nil
                                self.photoData = nil
                            }
                        }
                    }
                    return
                } catch {
                    guard !Task.isCancelled, self.user == user, self.visit == visit else { return }
                    var refusal = error as? AskRefusal
                    if let failure = error as? WindmillApiError, case .refused = failure {
                        refusal = AskRefusal(failure)
                    }
                    if refusal != nil || attempt == 2 {
                        let refusal = refusal ?? AskRefusal(line: "Response interrupted. Try again.", mayRetry: true)
                        self.conversation.settle(request.requestId,
                            .refused(AskRefusal(line: refusal.line, mayRetry: true, ceiling: refusal.ceiling)))
                        if refusal.needsPhotoUpload, let photo = self.photo, request.attachmentIds?.contains(photo.id) == true {
                            self.uploadPhoto()
                        }
                        return
                    }
                    do { try await Task.sleep(for: .seconds(attempt + 1)) }
                    catch { return }
                }
            }
        }
    }

    func stop() {
        guard let user, let api, let exchange = conversation.exchanges.last, conversation.waiting else { return }
        let request = requests.seat(user).requests[conversation.threadId]
            ?? CoachRequest(thread: conversation.threadId, question: exchange.question, requestId: exchange.id,
                            attachmentIds: exchange.attachments.map(\.id))
        let visit = visit
        Task {
            do {
                let generation = try await api.stopCoach(request)
                guard self.user == user, self.visit == visit else { return }
                conversation.accept(generation)
                if generation.status == "stopped" || generation.status == "completed" {
                    try requests.resolve(request, user: user)
                    responseTask?.cancel()
                    if photo?.id == request.attachmentIds?.first { removePhoto() }
                }
            } catch {
                guard self.user == user, self.visit == visit else { return }
                conversation.historyFailure = "Stop did not reach Coach. Try Stop again."
            }
        }
    }

    func load(older: Bool = false) async {
        guard !conversation.isLoading, let user, let api else { return }
        let thread = conversation.threadId
        let visit = visit
        let before = older ? conversation.nextCursor : nil
        conversation.isLoading = true
        do {
            let found = try await api.thread(thread, before: before)
            guard self.user == user, self.visit == visit else { return }
            conversation.isLoading = false
            guard let found else { return }
            conversation.merge(found, older: older)
            if !older, let generation = found.generation {
                let request = CoachRequest(thread: thread, question: generation.question,
                    requestId: generation.requestId, attachmentIds: generation.attachments.map(\.id))
                if generation.status == "completed" || generation.status == "stopped" {
                    try requests.resolve(request, user: user)
                    if photo?.id == generation.attachments.first?.id {
                        try requests.savePhoto(nil, thread: thread, user: user)
                        photo = nil
                        photoData = nil
                    }
                }
                if generation.status == "running" {
                    try requests.save(request, user: user, clearDraft: false)
                    send(request)
                }
            }
        } catch {
            guard self.user == user, self.visit == visit else { return }
            conversation.isLoading = false
            conversation.historyFailure = AskRefusal(error).line
        }
    }

    func addPhoto(_ data: Data) {
        guard let user, !conversation.waiting, conversation.unresolved == nil else { return }
        photoTask?.cancel()
        photoBusy = true
        photoFailure = nil
        let thread = conversation.threadId
        let visit = visit
        photoTask = Task {
            do {
                let normalized = try await Task.detached { try CoachPhoto.normalized(data) }.value
                guard !Task.isCancelled, self.user == user, self.visit == visit else { return }
                try requests.savePhoto(normalized.draft, data: normalized.data, thread: thread, user: user)
                photo = normalized.draft
                photoData = normalized.data
                photoBusy = false
                uploadPhoto()
            } catch {
                guard self.user == user, self.visit == visit else { return }
                photoBusy = false
                photoFailure = (error as? AskRefusal)?.line ?? "This photo could not be saved on this device."
            }
        }
    }

    func uploadPhoto() {
        guard let user, let api, var photo, let photoData else { return }
        photoTask?.cancel()
        let thread = conversation.threadId
        let visit = visit
        photo.uploaded = false
        self.photo = photo
        photoBusy = false
        uploadProgress = nil
        do { try requests.savePhoto(photo, thread: thread, user: user) }
        catch {
            photoFailure = "This photo could not be saved on this device."
            return
        }
        photoBusy = true
        photoFailure = nil
        uploadProgress = 0
        photoTask = Task {
            do {
                let uploaded = try await api.uploadCoachPhoto(photo, data: photoData, thread: thread) { progress in
                    Task { @MainActor [weak self] in
                        guard let self, self.user == user, self.visit == visit, self.photoBusy else { return }
                        self.uploadProgress = progress
                    }
                }
                guard !Task.isCancelled, self.user == user, self.visit == visit else { return }
                guard uploaded.id == photo.id else { throw WindmillApiError.malformed }
                var ready = photo
                ready.uploaded = true
                try requests.savePhoto(ready, thread: thread, user: user)
                self.photo = ready
                photoBusy = false
                uploadProgress = nil
            } catch {
                guard self.user == user, self.visit == visit, !Task.isCancelled else { return }
                photoBusy = false
                uploadProgress = nil
                photoFailure = "Photo didn’t upload."
            }
        }
    }

    func cancelPhotoUpload() {
        photoTask?.cancel()
        photoBusy = false
        uploadProgress = nil
    }

    func removePhoto() {
        guard let user, !conversation.waiting, conversation.unresolved == nil else { return }
        cancelPhotoUpload()
        do {
            try requests.savePhoto(nil, thread: conversation.threadId, user: user)
            photo = nil
            photoData = nil
            photoFailure = nil
        } catch { photoFailure = "This photo could not be removed. Try again." }
    }

    func readPhoto(_ id: String, thread: String) async throws -> Data {
        guard let user, let api else { throw WindmillApiError.offline }
        if let data = try? requests.photoData(id, thread: thread, user: user) { return data }
        return try await api.coachPhoto(id, thread: thread)
    }
}
