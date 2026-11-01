import com.fasterxml.jackson.databind.*;
import maestro.cli.session.*;
import maestro.harmonyos.hdc.*;
import kotlin.Unit;
import java.nio.file.*;
import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** Exercises the production recovery with actual local shell commands; never invokes HDC or a device. */
class CleanupFenceProducer {
    static final ObjectMapper JSON = HarmonyOsMaintenanceEvidence.Companion.getMapper();
    static final String DEVICE = "cleanup-fence-fixture";
    final Path root;
    final String bash, mode, owner = UUID.randomUUID().toString(), since = Instant.now().toString();
    final AtomicInteger commandNumber = new AtomicInteger();
    final HdcClient hdc;
    String originalWrapper;
    String remoteRoot, remoteFile, operation;
    boolean faultUsed, gateFaultUsed;
    final byte[] originalJournal, originalReceipt;
    final Path journalPath, originalReceiptPath;
    final HarmonyOsCleanupFenceRecovery recovery;

    CleanupFenceProducer(Path root, String bash, String mode) throws Exception {
        this.root = root.toAbsolutePath().normalize(); this.bash = bash; this.mode = mode;
        Files.createDirectory(this.root); Files.createDirectory(this.root.resolve("remote"));
        hdc = new HdcClient("local-shell-only", (command, timeout) -> {
            String script = decode(command.get(command.size() - 1));
            boolean claim = script.contains("/fence.pending");
            boolean clean = !claim && script.contains("mv ") && script.contains("/cleaned.pending");
            try {
                if (mode.equals("before-marker") && claim && !faultUsed) {
                    faultUsed = true;
                    script = script.replace("printf '%s' \"$__p\" >", "exit 124; printf '%s' \"$__p\" >");
                }
                HdcCommandResult result = shell(script);
                if (!faultUsed && ((mode.equals("lost-claim") && claim) || (mode.equals("lost-clean") && clean))) {
                    faultUsed = true;
                    return new HdcCommandResult(0, "synthetic response loss", "");
                }
                if (!faultUsed && mode.equals("cancel-after-claim") && claim) {
                    faultUsed = true;
                    Thread.currentThread().interrupt();
                    CleanupFenceProducer.<RuntimeException>raise(new InterruptedException("Synthetic cancellation after remote completion"));
                }
                return result;
            } catch (Exception error) {
                if (error instanceof InterruptedException) CleanupFenceProducer.<RuntimeException>raise(error);
                throw new RuntimeException(error);
            }
        }, Duration.ofSeconds(15), null, false);
        HarmonyOsSessionSupport.INSTANCE.withDeviceLock$maestro_cli(DEVICE, this.root, () -> {
            var lease = HarmonyOsSessionLease.Companion.begin(DEVICE, owner, this.root, false, hdc);
            String file = lease.getJournal().allocateTemporaryFile$maestro_client("layout", "json");
            if (mode.equals("inventory")) {
                try { Files.createDirectories(local(file).getParent()); }
                catch (Exception error) { throw new RuntimeException(error); }
                for (int i = 0; i < 7; i++) hdc.withRecoveryJournal(lease.getJournal()).shell(DEVICE, List.of("printf", "completed"), Duration.ofSeconds(3));
                for (int i = 0; i < 3; i++) lease.getJournal().allocateTemporaryFile$maestro_client(i == 0 ? "layout" : "screen", i == 0 ? "json" : "png");
            }
            var capture = new HdcClient("capture-only", (command, timeout) -> {
                originalWrapper = decode(command.get(command.size() - 1));
                return new HdcCommandResult(0, "original response absent", "");
            }, Duration.ofSeconds(3), null, false).withRecoveryJournal(lease.getJournal());
            try { capture.shell(DEVICE, List.of("rm", "-f", file), Duration.ofSeconds(3)); throw new AssertionError("Missing proof accepted"); }
            catch (HdcException expected) { }
            HarmonyOsRecoverySupport.INSTANCE.noteUncertainCleanup(owner, "Fixture original response loss");
            try { lease.finish(null, hdc); throw new AssertionError("Original lease released"); }
            catch (maestro.cli.harmonyos.AgentProtocolException expected) { }
            return Unit.INSTANCE;
        });
        JsonNode gate = gate(); journalPath = Path.of(gate.get("journalPath").asText());
        originalJournal = Files.readAllBytes(journalPath);
        originalReceiptPath = Path.of(gate.get("reportPath").asText()); originalReceipt = Files.readAllBytes(originalReceiptPath);
        JsonNode journal = JSON.readTree(originalJournal);
        remoteRoot = journal.get("remoteRoot").asText(); remoteFile = journal.get("temporaryFiles").get(0).asText();
        for (JsonNode item : journal.get("operations")) if (!item.get("completed").asBoolean()) operation = remoteRoot + "/" + item.get("id").asText();
        Files.createDirectories(local(remoteFile).getParent()); Files.writeString(local(remoteFile), "owned layout");
        if (mode.equals("inventory")) for (JsonNode item : journal.get("temporaryFiles")) Files.writeString(local(item.asText()), "owned fixture");
        if (mode.equals("old-wins")) check(shell(originalWrapper).getExitCode() == 0, "Original fixture did not complete");
        if (mode.equals("unknown-child")) Files.writeString(local(remoteRoot).resolve("foreign"), "not owned");
        Path tool = Files.writeString(this.root.resolve("fixture-tool"), "not an executable");
        var fingerprint = HarmonyOsMaintenanceEvidence.Companion.fingerprint(tool);
        var origin = new CleanupFenceOrigin("exclusive-operation-mkdir-v1",
            "c1de9567295e53022f9a2422593c5b7516b30bef4a66de956ff8d510fc20b0ac", fingerprint);
        recovery = new HarmonyOsCleanupFenceRecovery(this.root, origin, Map.of("fixture", fingerprint), hdc, (directory, next) -> {
            if (mode.equals("lost-gate-commit") && next.getState().equals("clean") && !gateFaultUsed) {
                gateFaultUsed = true; throw new RuntimeException("Synthetic final gate write failure");
            }
            HarmonyOsSessionLeaseKt.writeGate(directory, next); return Unit.INSTANCE;
        });
    }
    Path local(String remote) { return root.resolve("remote").resolve(remote.substring("/data/local/tmp/".length())); }
    static String decode(String command) {
        String prefix = "'sh' '-c' '";
        if (!command.startsWith(prefix) || !command.endsWith("'")) throw new IllegalArgumentException("Unexpected shell wrapper");
        return command.substring(prefix.length(), command.length() - 1).replace("'\"'\"'", "'");
    }
    HdcCommandResult shell(String script) throws Exception {
        int id = commandNumber.incrementAndGet();
        Path source = root.resolve("command-" + id + ".sh"), stdout = root.resolve("stdout-" + id), stderr = root.resolve("stderr-" + id);
        Files.writeString(source, script.replace("/data/local/tmp/", "./remote/") + "\n", StandardOpenOption.CREATE_NEW);
        Process process = new ProcessBuilder(bash, source.toString().replace('\\', '/')).directory(root.toFile())
            .redirectOutput(stdout.toFile()).redirectError(stderr.toFile()).start();
        if (!process.waitFor(15, TimeUnit.SECONDS)) { process.destroyForcibly().waitFor(); throw new IllegalStateException("Fixture shell timeout"); }
        return new HdcCommandResult(process.exitValue(), Files.readString(stdout), Files.readString(stderr));
    }
    JsonNode gate() throws Exception {
        return JSON.readTree(HarmonyOsSessionLeaseKt.gatePath(root, DEVICE).toFile());
    }
    void save(String name, Object value) throws Exception { Files.write(root.resolve(name), JSON.writerWithDefaultPrettyPrinter().writeValueAsBytes(value), StandardOpenOption.CREATE_NEW); }
    static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
    @SuppressWarnings("unchecked") static <T extends Throwable> void raise(Throwable error) throws T { throw (T) error; }
    void expectBlocked() throws Exception {
        try { recovery.recover(DEVICE, owner); throw new AssertionError("Recovery unexpectedly released"); }
        catch (Exception expected) {
            boolean interrupted = Thread.interrupted();
            save("expected-failure-" + UUID.randomUUID() + ".json", Map.of("message", expected.toString(), "interrupted", interrupted));
            if (mode.equals("cancel-after-claim") && expected instanceof InterruptedException) check(interrupted, "Cancellation flag was lost");
        }
        check(gate().get("state").asText().equals("quarantined"), "Failed recovery changed lease state");
    }
    void run() throws Exception {
        boolean remainsBlocked = Set.of("before-marker", "old-wins", "unknown-child", "cancel-after-claim").contains(mode);
        if (!Set.of("complete", "inventory", "new-lease", "removed-fence", "normal-recover-refused").contains(mode)) {
            expectBlocked();
            Thread.interrupted();
        }
        if (remainsBlocked) {
            if (mode.equals("before-marker") || mode.equals("cancel-after-claim")) expectBlocked();
            if (mode.equals("old-wins")) check(gate().get("schemaVersion").asInt() == 1,
                "An acknowledged failed claim should restore the ordinary quarantine");
            save("input.json", Map.of("deviceId", DEVICE, "recoveryRoot", root.toString(), "createdAt", since));
        } else {
            Map<String,Object> response = (Map) recovery.recover(DEVICE, owner);
            check(Boolean.TRUE.equals(response.get("handoffReady")), "No isolation handoff");
            save("response.json", response);
            save("input.json", Map.of("deviceId", DEVICE, "recoveryRoot", root.toString(), "createdAt", since, "responsePath", root.resolve("response.json").toString()));
            check(shell(originalWrapper).getExitCode() == 119, "Late original command crossed the retained barrier");
            check(Files.isDirectory(local(operation)) && !Files.exists(local(remoteFile)), "Fence or cleanup differs");
            if (mode.equals("normal-recover-refused")) {
                try { HarmonyOsRecoverySupport.INSTANCE.recover(DEVICE, owner, hdc, root, Duration.ofSeconds(10)); throw new AssertionError("Ordinary recovery accepted fenced owner"); }
                catch (maestro.cli.harmonyos.AgentProtocolException expected) { }
                check(Files.isDirectory(local(operation)), "Ordinary recovery removed the barrier");
            }
            if (mode.equals("removed-fence")) Files.delete(local(operation).resolve("fence"));
            if (mode.equals("new-lease") || mode.equals("removed-fence")) {
                HarmonyOsSessionSupport.INSTANCE.withDeviceLock$maestro_cli(DEVICE, root, () -> {
                    if (mode.equals("removed-fence")) {
                        try { HarmonyOsSessionLease.Companion.begin(DEVICE, UUID.randomUUID().toString(), root, false, hdc); throw new AssertionError("Missing barrier accepted"); }
                        catch (Exception expected) { }
                    } else {
                        var lease = HarmonyOsSessionLease.Companion.begin(DEVICE, UUID.randomUUID().toString(), root, false, hdc);
                        lease.finish(null, hdc);
                    }
                    return Unit.INSTANCE;
                });
                check(gate().get("schemaVersion").asInt() == 3 && gate().get("retainedFences").size() == 1, "Retained inventory was lost");
            }
        }
        check(Arrays.equals(originalJournal, Files.readAllBytes(journalPath)), "Original journal changed");
        check(Arrays.equals(originalReceipt, Files.readAllBytes(originalReceiptPath)), "Original receipt changed");
        save("producer.json", Map.of("passed", true, "mode", mode, "device", false, "blocked", remainsBlocked,
            "originalJournalUnchanged", true, "originalReceiptUnchanged", true, "shellCommands", commandNumber.get()));
    }
    public static void main(String[] args) throws Exception {
        if (args.length != 3) throw new IllegalArgumentException("NEW_OUTPUT BASH MODE");
        new CleanupFenceProducer(Path.of(args[0]), args[1], args[2]).run();
    }
}
