pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        // Google's mirror of Maven Central comes first: Maven Central answers GitHub's runners with 429 when
        // they fetch many artifacts at once, and a module the mirror lacks falls through to Maven Central.
        maven("https://maven-central.storage-download.googleapis.com/maven2/")
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        // The same mirror first, as for plugins above.
        maven("https://maven-central.storage-download.googleapis.com/maven2/")
        mavenCentral()
    }
}

rootProject.name = "windmill-android"

include(":app", ":platform", ":gym")
include(":sync-core", ":sync-schema", ":sync-testing", ":domain-kit", ":domain-kit-testing")
include(":sync-api")
include(":sync-engine")
include(":gym:domain")
include(":sync-model-server")
include(":agent")
