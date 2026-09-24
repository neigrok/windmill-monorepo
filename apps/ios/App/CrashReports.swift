import Foundation
import Sentry

enum CrashReports {
    static func options(info: [String: Any]) -> Options? {
        guard let dsn = info["IOS_SENTRY_DSN"] as? String,
              !dsn.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }

        let options = Options()
        options.dsn = dsn
        guard options.parsedDsn != nil else { return nil }
        #if DEBUG
        options.environment = "development"
        #else
        options.environment = "production"
        #endif
        let version = info["CFBundleShortVersionString"] as? String ?? "0"
        let build = info["CFBundleVersion"] as? String ?? "0"
        options.releaseName = "windmill-ios@\(version)+\(build)"
        options.dist = build
        options.sendDefaultPii = false
        options.enableMemoryIntrospection = false
        options.attachScreenshot = false
        options.attachViewHierarchy = false
        options.enableAutoBreadcrumbTracking = false
        options.enableNetworkBreadcrumbs = false
        options.enableNetworkTracking = false
        options.enableCaptureFailedRequests = false
        options.enableSwizzling = false
        options.enableAutoPerformanceTracing = false
        options.enableAutoSessionTracking = false
        options.enableLogs = false
        options.enableMetrics = false
        options.tracesSampleRate = 0
        options.sessionReplay.sessionSampleRate = 0
        options.sessionReplay.onErrorSampleRate = 0
        options.beforeBreadcrumb = { _ in nil }
        options.beforeSend = { event in
            event.message = nil
            event.request = nil
            event.breadcrumbs = nil
            event.extra = nil
            event.user = nil
            event.tags = ["platform": "ios"]
            event.context = event.context?.filter { ["app", "device", "os", "runtime"].contains($0.key) }
            for exception in event.exceptions ?? [] {
                exception.value = nil
                exception.mechanism?.desc = nil
                exception.mechanism?.data = nil
            }
            return event
        }
        return options
    }
}
