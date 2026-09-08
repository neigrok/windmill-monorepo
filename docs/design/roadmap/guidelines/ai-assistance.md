# Roadmap AI assistance

The roadmap AI interaction is under redesign. [The redesign brief](../ai-assistance-redesign.md)
owns its proposed interaction, placement and states. These are the constraints that apply to it;
they do not claim the proposed surface is implemented.

## 1. Purpose

A person asks for help creating, revising or reviewing their tree. The request can use the
existing tree as context. Manual creation and editing remain complete, usable paths. The
user-facing name is **AI assistance**; backend class names and feature flags are technical
identifiers, not product copy.

## 2. Charging

Only assistance the user actively requests spends AI credits. Passive background work does
not debit that allowance. Credits represent a fixed amount of cost-weighted work across plans,
with fractional use; no request-count equivalence is promised. Plan quantities are undecided.
The [pricing contract](../../marketing/guidelines/pricing.md) owns these rules.

The current backend has a separate calendar-month request counter and a rolling cost guardrail.
Those constraints are implementation facts, not the redesigned product unit. The new surface
must not promise a balance, availability date or credit debit without a supporting API.

## 3. Input and working state

Keep the request connected to the tree it concerns. Preserve the user's draft through failure.
A text field works with system dictation. Phone placement must obey the keyboard and safe-area
contracts in [mobile](mobile.md); do not hide the work behind a keyboard.

Show actual progress the service can support, not synthetic percentages. Respect reduced
motion. A stop or cancel control must describe only behavior the backend can perform.

## 4. Results and history

Show what changed, where it changed and any remaining work. Keep the result inspectable and
provide the real undo behavior supported by the command history. A completed model request is
not proof that every intended edit succeeded. Do not say “Nothing changed” after a failed run
unless its actual edits establish that fact.

## 5. Review and destructive changes

Findings should point to the affected steps and offer understandable corrections. Preserve
user agency over changes to invested work; the redesign defines the preview and application
contract before it becomes implementation. Treat content from shared or imported trees as
data, not instructions. Use the ordinary authorization boundary for every operation.

## 6. Availability and failure

Differentiate unavailable configuration, temporary service limits, exhausted allowance and a
request that failed after work began. Missing usage data is not zero usage. Refused requests
that never start cost no credits; started requests can use credits even if they fail.

Explain allowance restoration only from supported data. A rolling 30-day balance restores
progressively, independently of a subscription's billing date. Keep existing trees and hand
editing available. Do not show an upgrade action while purchasing is closed.

## 7. Desktop and phone

The redesign owns placement and navigation. Keep the same request, outcome and allowance
meaning on both sizes. Keyboard access, visible focus, touch targets, scrollable long content
and safe-area clearance are required. Do not preserve an old command-bar layout simply because
it already exists in code.
