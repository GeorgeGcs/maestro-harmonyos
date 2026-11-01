import com.fasterxml.jackson.databind.*;
import maestro.cli.session.*;
import maestro.harmonyos.hdc.*;
import kotlin.Unit;
import java.nio.file.*;
import java.time.Duration;
import java.time.Instant;
import java.util.*;

/** Explicit device filesystem probe. Holds the actual device lock; never releases its real owner or operates UI. */
class CleanupFenceDeviceProbe {
    static final ObjectMapper JSON = HarmonyOsMaintenanceEvidence.Companion.getMapper();
    final Path root, state, actualLocks, actualGate, originalCli;
    final String device, action;
    final HdcClient hdc;
    final Path hdcPath;
    CleanupFenceDeviceProbe(String[] args) {
        root = Path.of(args[0]).toAbsolutePath().normalize(); state = root.resolve("state");
        action = args[1]; hdcPath = Path.of(args[2]).toAbsolutePath().normalize(); device = args[3]; originalCli = Path.of(args[4]);
        actualLocks = Path.of(System.getProperty("user.home"), ".maestro", "harmonyos-sessions");
        actualGate = HarmonyOsSessionLeaseKt.gatePath(actualLocks, device);
        hdc = new HdcClient(hdcPath.toString(), new ProcessHdcCommandRunner(), Duration.ofSeconds(15), null, false);
    }
    static String hash(byte[] bytes) { return HarmonyOsMaintenanceEvidence.Companion.digest(bytes); }
    static String q(String text) { return "'" + text.replace("'", "'\"'\"'") + "'"; }
    void save(String name, Object value) throws Exception {
        Files.write(root.resolve(name), JSON.writerWithDefaultPrettyPrinter().writeValueAsBytes(value), StandardOpenOption.CREATE_NEW);
    }
    void command(String name, String script, String expected) throws Exception {
        save(name + "-command.json", Map.of("script", script));
        var result = hdc.shell(device, List.of("sh", "-c", script), Duration.ofSeconds(15));
        save(name + "-result.json", Map.of("exit", result.getExitCode(), "stdout", result.getStdout(), "stderr", result.getStderr()));
        if (result.getExitCode() != 0 || !result.getStderr().isEmpty() || !result.getStdout().strip().equals(expected)) {
            throw new IllegalStateException("Isolated probe command was not confirmed: " + name);
        }
    }
    void runLocked() throws Exception {
        byte[] before = Files.readAllBytes(actualGate);
        JsonNode actual = JSON.readTree(before);
        if (!actual.path("state").asText().equals("quarantined") || actual.hasNonNull("maintenance") || actual.hasNonNull("cleanupFence")) {
            throw new IllegalStateException("Actual owner must remain in its original quarantine");
        }
        Path originalJournal = Path.of(actual.get("journalPath").asText());
        byte[] journalBytes = Files.readAllBytes(originalJournal);
        if (action.equals("crash-after-claim")) {
            Files.createDirectory(root);
            save("actual-before.json", Map.of("gateSha256", hash(before), "journalSha256", hash(journalBytes), "actualSessionReleased", false));
            String owner = UUID.randomUUID().toString();
            save("identity.json", Map.of("owner", owner, "deviceId", device, "createdAt", Instant.now().toString()));
            HarmonyOsSessionSupport.INSTANCE.withDeviceLock$maestro_cli(device, state, () -> {
                var lease = HarmonyOsSessionLease.Companion.begin(device, owner, state, false, hdc);
                String layout = lease.getJournal().allocateTemporaryFile$maestro_client("layout", "json");
                String screen = lease.getJournal().allocateTemporaryFile$maestro_client("screen", "png");
                var capture = new HdcClient("never-dispatched", (cmd, timeout) -> {
                    String encoded = cmd.get(cmd.size() - 1), prefix = "'sh' '-c' '";
                    if (!encoded.startsWith(prefix) || !encoded.endsWith("'")) throw new IllegalStateException("Unexpected original wrapper");
                    try { Files.writeString(root.resolve("original-wrapper.txt"), encoded.substring(prefix.length(), encoded.length() - 1).replace("'\"'\"'", "'"), StandardOpenOption.CREATE_NEW); }
                    catch (Exception error) { throw new RuntimeException(error); }
                    return new HdcCommandResult(0, "synthetic original not sent", "");
                }, Duration.ofSeconds(3), null, false).withRecoveryJournal(lease.getJournal());
                try { capture.shell(device, List.of("rm", "-f", layout), Duration.ofSeconds(3)); throw new AssertionError("Missing proof accepted"); }
                catch (HdcException expected) { }
                HarmonyOsRecoverySupport.INSTANCE.noteUncertainCleanup(owner, "Isolated filesystem fixture");
                try { lease.finish(null, hdc); throw new AssertionError("Synthetic pending operation released"); }
                catch (maestro.cli.harmonyos.AgentProtocolException expected) { }
                return Unit.INSTANCE;
            });
        } else {
            JsonNode expected = JSON.readTree(root.resolve("actual-before.json").toFile());
            if (!hash(before).equals(expected.get("gateSha256").asText()) || !hash(journalBytes).equals(expected.get("journalSha256").asText())) {
                throw new IllegalStateException("Actual blocked owner changed since the probe began");
            }
        }
        try {
            hdc.selectDevice(device);
            JsonNode identity = JSON.readTree(root.resolve("identity.json").toFile());
            String owner = identity.get("owner").asText();
            JsonNode fakeGate = JSON.readTree(HarmonyOsSessionLeaseKt.gatePath(state, device).toFile());
            JsonNode fakeJournal = JSON.readTree(Path.of(fakeGate.get("journalPath").asText()).toFile());
            String remoteRoot = fakeJournal.get("remoteRoot").asText();
            if (remoteRoot.equals(JSON.readTree(journalBytes).get("remoteRoot").asText())) throw new IllegalStateException("Actual root is prohibited");
            String operation = remoteRoot + "/" + fakeJournal.get("operations").get(0).get("id").asText();
            if (action.equals("crash-after-claim")) {
                String marker = "PROBE_SETUP_" + UUID.randomUUID();
                String script = "umask 077; [ ! -e " + q(remoteRoot) + " ] && [ ! -L " + q(remoteRoot) + " ] && mkdir " + q(remoteRoot) + " && mkdir " + q(remoteRoot + "/files");
                for (JsonNode file : fakeJournal.get("temporaryFiles")) script += " && printf fixture > " + q(file.asText());
                command("setup", script + " && printf '%s' " + q(marker), marker);
            }
            if (action.equals("cleanup-fixture")) {
                String marker = "PROBE_REMOVED_" + UUID.randomUUID();
                // The synthetic old command was never sent before the fence. Its explicit late replay returned 119.
                if (!Files.exists(root.resolve("late-replay-result.json")) || !Files.exists(root.resolve("resume-result.json"))) throw new IllegalStateException("Fixture execution is incomplete");
                command("cleanup", "[ ! -L " + q(remoteRoot) + " ] && [ ! -L " + q(operation) + " ] && " +
                    "rm " + q(operation + "/fence") + " " + q(operation + "/cleaned") + " && rmdir " + q(operation) +
                    " && rmdir " + q(remoteRoot + "/files") + " && rmdir " + q(remoteRoot) + " && printf '%s' " + q(marker), marker);
                save("cleanup-summary.json", Map.of("isolatedFixtureRemoved", true, "actualSessionReleased", false));
                return;
            }
            var tools = new LinkedHashMap<String, HarmonyOsMaintenanceHostBoot.Tool>();
            tools.put("hdc", HarmonyOsMaintenanceEvidence.Companion.fingerprint(hdcPath));
            tools.put("java", HarmonyOsMaintenanceEvidence.Companion.fingerprint(Path.of(System.getProperty("java.home"), "bin", "java.exe")));
            int index = 0;
            for (String entry : System.getProperty("java.class.path").split(java.util.regex.Pattern.quote(java.io.File.pathSeparator))) {
                Path jar = Path.of(entry).toAbsolutePath().normalize();
                tools.put("classpath:" + index++ + ":" + jar.getFileName(), HarmonyOsMaintenanceEvidence.Companion.fingerprint(jar));
            }
            var recovery = new HarmonyOsCleanupFenceRecovery(state, HarmonyOsCleanupFenceEvidence.INSTANCE.origin(originalCli), tools, hdc, (directory, next) -> {
                if (action.equals("crash-after-claim") && next.getCleanupFence() != null) {
                    try {
                        Path evidence = HarmonyOsCleanupFenceEvidence.INSTANCE.root(state, device, owner, next.getCleanupFence().getRecoveryId());
                        JsonNode step = JSON.readTree(evidence.resolve(next.getCleanupFence().getHead().getPath()).toFile());
                        if (step.get("calls").size() == 1 && !step.get("calls").get(0).get("outcome").isNull()) {
                            if (!Arrays.equals(before, Files.readAllBytes(actualGate)) || !Arrays.equals(journalBytes, Files.readAllBytes(originalJournal))) throw new IllegalStateException("Actual owner changed");
                            save("crash-point.json", Map.of("phase", "claim returned; outcome not committed to gate", "actualSessionReleased", false));
                            Runtime.getRuntime().halt(91); // Only this dedicated test JVM; device and computer keep running.
                        }
                    } catch (Exception error) { throw new RuntimeException(error); }
                }
                HarmonyOsSessionLeaseKt.writeGate(directory, next); return Unit.INSTANCE;
            });
            var response = recovery.recover(device, owner);
            if (!Boolean.TRUE.equals(response.get("handoffReady"))) throw new IllegalStateException("Fixture did not recover");
            save("response.json", response);
            save("input.json", Map.of("deviceId", device, "recoveryRoot", state.toString(), "createdAt", identity.get("createdAt").asText(),
                "responsePath", root.resolve("response.json").toString()));
            String marker = "LATE_REPLAY_" + UUID.randomUUID() + "=";
            String old = Files.readString(root.resolve("original-wrapper.txt"));
            command("late-replay", "sh -c " + q(old) + " 2>/dev/null; __probe=$?; printf '\\n" + marker + "%s' \"$__probe\"", marker + "119");
            save("resume-result.json", Map.of("isolatedFixtureReleased", true, "actualSessionReleased", false, "originalJournalUnchanged", true));
        } finally {
            boolean unchanged = Arrays.equals(before, Files.readAllBytes(actualGate)) && Arrays.equals(journalBytes, Files.readAllBytes(originalJournal));
            save(action + "-actual-after.json", Map.of("unchanged", unchanged, "actualSessionReleased", false));
            if (!unchanged) throw new IllegalStateException("Actual blocked owner changed");
        }
    }
    public static void main(String[] args) throws Exception {
        if (args.length != 5 || !Set.of("crash-after-claim", "resume", "cleanup-fixture").contains(args[1])) {
            throw new IllegalArgumentException("OUTPUT ACTION HDC DEVICE ORIGINAL_CLI");
        }
        var probe = new CleanupFenceDeviceProbe(args);
        HarmonyOsSessionSupport.INSTANCE.withDeviceLock$maestro_cli(probe.device, probe.actualLocks, () -> {
            try { probe.runLocked(); return Unit.INSTANCE; } catch (Exception error) { throw new RuntimeException(error); }
        });
    }
}
