# TelemetryPolicy.failureKind uses throwable class names as stable labels.
-keepnames class * extends java.lang.Throwable

# Sentry retraces release stack frames with source line numbers.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
