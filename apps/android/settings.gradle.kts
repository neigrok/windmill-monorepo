pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
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
