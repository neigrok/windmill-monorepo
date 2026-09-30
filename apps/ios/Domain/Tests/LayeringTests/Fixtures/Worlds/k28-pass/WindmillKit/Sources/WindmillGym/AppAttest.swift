import DeviceCheck

enum Attest { static var supported: Bool { DCAppAttestService.shared.isSupported } }
