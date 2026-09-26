# Android target entry — open alternatives

The control choice remains open. Targets stay an ordered per-set scheme, with the shared
`TargetBlock(scheme, onChange)` boundary defined in [android-delivery.md](android-delivery.md).
The create sheet uses A's scheme block while the alternatives await a decision.

The editable boards are in [Android · Screens, target entry](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=815-5196),
412 × 915 in Instrument mode. Each option compares uniform `4 × 10 · 60 kg` with a
`60 / 70 / 80 / 80` ramp. These are static proposals, not device-tested controls.

| Option | Interaction and tradeoff | Uniform / ramp boards |
|---|---|---|
| A · One line, fans out | Sets, Reps and kg steppers; unequal neighbouring loads group into runs. Ramp up fills plate steps; Same for all collapses runs; Vary by set opens the full ladder when reps differ. Best standalone editor. | `823:5414` / `823:5545` |
| B · Copy-down | Every set has a row; values flow down until a lower row is edited. Faint values mean “follows”. Exact, but retains every row and requires learning the follow rule. | `823:5709` / `823:5880` |
| C · Wheels | Three wheels plus a segment to select a set. A ramp requires four trips and a custom Compose wheel. | `823:6062` / `823:6206` |
| D · Type the scheme | Parse `sets × reps kg`, slash-separated loads, plate-step ranges and a leading minus for assistance. A keypad adds `× / –` and `kg`; a live readout previews the parse. Exact, but introduces a grammar and retyping instead of nudging. | `837:5732` / `837:5886` |
| E · Your schemes | Up to six schemes from the lifter's routines and log, most-used first, with Last time selected; one load stepper shifts the scheme. Cold start offers `3 × 10`, `4 × 8`, `5 × 5`. Edit sets opens A. Faster recall, but needs a scheme-selection rule. | `838:5828` / `838:5953` |
| F · Drag the bars | One snapped load slider per set, with reps opening a keypad. Hold levels later sets; drag below the floor removes; a ghost column adds. The 60 kg window gives 8px per plate step, requiring precise dragging. | `839:5923` / `839:6064` |

The design recommendation is E backed by A; A remains the standalone recommendation. Ranking:
E, A, D, B, F, C. The baseline target sheet is `673:2567`, cloned as `823:5324`.
Shared Stepper row `821:5325` and Mini stepper `821:5344` live on Android · Components.
The separate workout-rack wheel comparison remains at `815:5201` / `815:5367`.

Before promotion, prototype the chosen editor, test uniform and varied reps/loads on a device,
and verify native keyboard, haptics, focus and TalkBack. D requires text-field semantics and a
spoken parse/error; E requires selected chip semantics; F requires accessible per-bar sliders.
The parser grammar, scheme ranking and slider snapping are unverified proposals.
