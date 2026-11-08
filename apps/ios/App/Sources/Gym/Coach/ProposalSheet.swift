import SwiftUI
import GymDomain

// A Routines row's proposal that the conversation on screen does not hold, on a sheet of its own (02L.9P).
struct ProposalSheet: View {
  let gym: GymModel
  let id: String
  var body: some View {
    NavigationStack { ProposalCard(gym: gym, id: id, in: .sheet) }
      .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
      .accessibilityIdentifier("gym-proposal-sheet")
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "review"]) }
  }
}

// The proposal as its sheet's Form (02L.9P, 02L.10P, 02L.11P): every change listed, a Section each, the first headed by the
// count and the last footed by the movements it leaves; Apply in the toolbar's confirmation slot, where a connected tool's
// removal asks first, and Reject a row of its own, which sets the proposal aside and closes the sheet. Who proposed it and
// when stands under the title, by its symbol. Applied, a row on top says so; out of date, a row on top says why, every
// change dimmed, and nothing is left to decide.
extension ProposalCard {
  @ViewBuilder var sheet: some View {
    let proposal = self.proposal
    let name = proposal.flatMap(gym.coachRoutine)?.name ?? proposal?.baseName ?? "Proposal"
    Form {
      Group {
        if let proposal { sections(proposal) }
        else { Text("That proposal is gone.").foregroundStyle(GymPalette.inkDim) }
      }.listRowBackground(GymPalette.card)
    }.modifier(GymPage())
      .navigationTitle(name)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          if #available(iOS 26.0, *) { Button(role: .close) { dismiss() } } else { Button("Close") { dismiss() } }
        }
        // The title over who proposed it and when, by its symbol — a navigation subtitle draws no symbol.
        ToolbarItem(placement: .principal) {
          VStack(spacing: 0) {
            Text(name).font(.headline)
            if let proposal { source(proposal).font(.footnote).foregroundStyle(GymPalette.inkDim) }
          }.accessibilityElement(children: .combine)
        }
        if let proposal, stance == .open { ToolbarItem(placement: .confirmationAction) { confirm(proposal) } }
      }.roomBar(.gym)
      .safeAreaInset(edge: .bottom) { GymTransient(gym: gym, errorIdentifier: "gym-coach-error") }
  }

  @ViewBuilder func sections(_ proposal: Proposal) -> some View {
    let listed = changes(proposal)
    let dimmed = outOfDate != nil
    if stance == .rejected {
      RejectedLine(subject: routineName, symbol: "xmark.circle").accessibilityIdentifier("coach-proposal-header").accessibilityValue("Rejected")
    } else {
      if stance == .applied || dimmed {
        Section {
          ProposalHeading(symbol: symbol.name, tint: symbol.tint, title: dimmed ? CoachCopy.outOfDate : title, reason: outOfDate, bounce: landed,
                          identifier: "coach-proposal", value: settled)
        }
      }
      ForEach(Array(listed.blocks.enumerated()), id: \.offset) { index, block in
        Section {
          ChangeTitle(kind: block.kind, title: block.title, dimmed: dimmed)
          ForEach(Array(block.fields.enumerated()), id: \.offset) { _, field in ProposalField(field: field, dimmed: dimmed).padding(.leading, column) }
        } header: {
          if index == 0, let changesHeader { Text(changesHeader) }
        } footer: {
          if index == listed.blocks.count - 1, listed.unchanged > 0 { Text("No change: " + GymCount.of(listed.unchanged, "movement")) }
        }
      }
      // Why the Apply did not land stands with the decisions, whatever the sheet lists.
      if stance == .open {
        Section {
          Button("Reject") { if gym.coachDecideProposal(proposal, apply: false) { dismiss() } }
            .disabled(!decision(stalled: stalled).rejects).accessibilityIdentifier("coach-reject-proposal")
        } footer: {
          if let failure { failureLine(failure) }
        }
      }
    }
  }

  // The toolbar's confirmation: the prominent checkmark that applies, a removal's destructive Remove, work in flight in its
  // place while the log has not answered, and Try again once the Apply failed or stalled.
  @ViewBuilder func confirm(_ proposal: Proposal) -> some View {
    let decision = decision(stalled: stalled)
    Group {
      if pending && !decision.retries { ProgressView().accessibilityLabel(decision.title) }
      else if decision.retries { Button("Try again") { decide(proposal) }.fontWeight(.semibold) }
      else if removal {
        let question = removalQuestion
        Button("Remove", role: .destructive) { if question == nil { decide(proposal) } else { confirmingRemoval = true } }
          .fontWeight(.semibold).tint(GymPalette.destructive)
          .destructiveQuestion(gym, screen: "review", title: question?.title ?? "", message: question?.message ?? "", act: "Remove routine",
                               dialog: true, isPresented: $confirmingRemoval) { decide(proposal) }
      } else if #available(iOS 26.0, *) {
        Button(role: .confirm) { decide(proposal) } label: {
          Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(decision.applies ? GymPalette.onAccent : GymPalette.inkFaint)
        }.buttonStyle(.glassProminent).tint(GymPalette.accent).accessibilityLabel("Apply")
      } else { Button { decide(proposal) } label: { Text("Apply").bold() }.tint(GymPalette.accent) }
    }.disabled(!decision.applies).accessibilityIdentifier("coach-apply-proposal")
  }

  // The first change's header: a removal says so; otherwise the count, which while it waits and a workout is open waits for
  // the routine's next workout, as the card's subtitle says (08.56P).
  var changesHeader: String? {
    guard let proposal else { return nil }
    if removal { return "Remove a routine" }
    return GymCount.of(gym.coachChangeCount(proposal), "change") + (stance == .open && nextTime ? " · next time" : "")
  }

  // What a connected tool's removal asks before it applies, in the tool's own name (02L.11P); none for Coach's, asked for in
  // its conversation, which applies at once.
  var removalQuestion: (title: String, message: String)? {
    guard let proposal, removal else { return nil }
    if case .ask = proposal.provenance { return nil }
    let source = proposal.sourceName.prefix(1).uppercased() + proposal.sourceName.dropFirst()
    return ("Remove \(routineName)?", "\(source) suggested this. Your past \(routineName) workouts stay in the log.")
  }

  // Who proposed it, then when the server stamped it, by its symbol: Coach's bubbles or a connected tool's link.
  func source(_ proposal: Proposal) -> some View {
    Label(RoutineLines.proposal(proposal, createdAt: gym.proposalCreatedAt(proposal), dates: gym.log == nil ? nil : gym.dates),
          systemImage: proposal.sourceSymbol).labelStyle(ChangeBadgeStyle())
  }
}
