plugins {
    alias(libs.plugins.kotlin.jvm)
}

kotlin {
    jvmToolchain(17)
    sourceSets {
        main {
            kotlin.srcDir("../.upstream/maestro/maestro-client/src/main/java")
            kotlin.srcDir("../.upstream/maestro/maestro-utils/src/main/kotlin")
            kotlin.include("maestro/harmonyos/**", "maestro/TreeNode.kt", "TempFileHandler.kt")
            kotlin.exclude("maestro/harmonyos/driver/**")
        }
        test {
            kotlin.srcDir("../.upstream/maestro/maestro-client/src/test/kotlin")
            kotlin.include("maestro/harmonyos/**")
            // These checks depend on the complete Maestro SDK and run with -FullUpstream.
            kotlin.exclude("maestro/harmonyos/layout/UitestMaestroSelectorTest.kt")
            kotlin.exclude("maestro/harmonyos/driver/**")
        }
    }
}

sourceSets.test {
    resources.srcDir("../.upstream/maestro/maestro-client/src/test/resources")
    resources.include("harmonyos/**")
}

dependencies {
    implementation(libs.jackson.core.databind)
    implementation(libs.jackson.module.kotlin)
    testImplementation(libs.junit.jupiter.api)
    testImplementation(libs.junit.jupiter.params)
    testImplementation(libs.google.truth)
    testRuntimeOnly(libs.junit.jupiter.engine)
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test {
    useJUnitPlatform()
    systemProperty("file.encoding", "UTF-8")
    testLogging { events("failed", "skipped") }
}

tasks.register<JavaExec>("devices") {
    group = "verification"
    description = "List HDC targets using the HarmonyOS adapter; does not operate a device."
    classpath = sourceSets.main.get().runtimeClasspath
    mainClass.set("maestro.harmonyos.HarmonyOsHostCli")
    args("devices")
}
