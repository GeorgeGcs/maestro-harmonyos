rootProject.name = "maestro-harmonyos-host-tests"

pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { mavenCentral() }
    versionCatalogs {
        create("libs") {
            from(files("../.upstream/maestro/gradle/libs.versions.toml"))
        }
    }
}
