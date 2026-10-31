import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import maestro.cli.harmonyos.AgentProtocolException;
import maestro.cli.session.*;
import maestro.harmonyos.hdc.*;
import kotlin.Unit;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import java.util.regex.Pattern;

/** Runs the production coordinator with in-process observations. Never starts HDC or PowerShell. */
class MaintenanceProducer {
    static final String DEVICE = "maintenance-producer-fixture";
    static final ObjectMapper JSON = HarmonyOsMaintenanceEvidence.Companion.getMapper();
    final Path root;
    final String owner = UUID.randomUUID().toString();
    final Map<String, HarmonyOsMaintenanceHostBoot.Tool> tools = new TreeMap<>();
    int hosts, calls;
    final boolean failObservation;

    MaintenanceProducer(Path root, boolean failObservation) throws Exception {
        this.root = root;
        this.failObservation = failObservation;
        Files.createDirectory(root); // Caller must choose a new, isolated directory.
        Path toolRoot = Files.createDirectory(root.resolve("fixture-tools"));
        for (String key : List.of("powershell", "script", "hdc", "java", "classpath:0:fixture.jar")) {
            Path file = toolRoot.resolve(key.equals("classpath:0:fixture.jar") ? "fixture.jar" : key + ".fixture");
            Files.writeString(file, "not executable: " + key, StandardOpenOption.CREATE_NEW);
            tools.put(key, HarmonyOsMaintenanceEvidence.Companion.fingerprint(file));
        }
    }

    static HdcClient client(HdcCommandRunner runner) {
        return new HdcClient("never-executed-fixture", runner, Duration.ofSeconds(3), null, false);
    }

    JsonNode observe(Path output) {
        try {
            int index = hosts++;
            Map<String, Object> ps = new LinkedHashMap<>(JSON.convertValue(tools.get("powershell"), Map.class));
            ps.put("version", "5.1.1.1");
            var value = Map.of("protocol", "maestro.harmonyos.host-boot-observation", "schemaVersion", 1,
                "provider", Map.of("name", "windows-gettickcount64-cim", "version", 1),
                "observedAt", "2026-10-30T0" + (index + 2) + ":00:00.000Z",
                "lastBootUpTime", index == 0 ? "2026-10-20T00:00:00.000Z" : "2026-10-30T00:00:00.000Z",
                "uptimeMilliseconds", index == 0 ? "900000000" : Integer.toString(1000 + index * 100),
                "machineIdSha256", "a".repeat(64), "tools", Map.of("powershell", ps, "script", tools.get("script")));
            Files.write(output, JSON.writeValueAsBytes(value), StandardOpenOption.CREATE_NEW);
            return JSON.readTree(Files.readAllBytes(output));
        } catch (Exception error) { throw new IllegalStateException(error); }
    }

    HdcClient transport() {
        return client((command, timeout) -> {
            calls++;
            if (!command.subList(0, 4).equals(List.of("never-executed-fixture", "-t", DEVICE, "shell")))
                throw new AssertionError("Unexpected fixture dispatch: " + command);
            if (command.get(command.size() - 1).equals("'uptime'")) {
                if (failObservation) throw new IllegalStateException("Synthetic lost observation");
                return new HdcCommandResult(0, calls == 1
                    ? " 23:02:14 up 4 days, 35 min,  0 users,  load average: 12.18, 12.26, 12.44\n"
                    : " 23:10:14 up 1 min,  0 users,  load average: 0.18, 0.26, 0.44\n", "");
            }
            String shell = command.get(command.size() - 1);
            if (shell.contains("rm -r") || shell.contains("*")) throw new AssertionError("Unexpected cleanup");
            var matcher = Pattern.compile("[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}").matcher(shell);
            String nonce = null;
            while (matcher.find()) nonce = matcher.group();
            if (nonce == null) throw new AssertionError("No cleanup acknowledgement");
            return new HdcCommandResult(0, nonce, "");
        });
    }

    void run() throws Exception {
        var forbidden = client((command, timeout) -> { throw new AssertionError("No dispatch permitted here"); });
        HarmonyOsSessionSupport.INSTANCE.withDeviceLock$maestro_cli(DEVICE, root, () -> {
            var lease = HarmonyOsSessionLease.Companion.begin(DEVICE, owner, root, false);
            var lost = client((command, timeout) -> new HdcCommandResult(0, "missing original proof", ""))
                .withRecoveryJournal(lease.getJournal());
            try {
                lost.shell(DEVICE, List.of("uitest", "dumpLayout"), Duration.ofSeconds(3));
                throw new AssertionError("Missing proof was accepted");
            } catch (HdcException expected) { }
            HarmonyOsRecoverySupport.INSTANCE.noteUncertainCleanup(owner, "Synthetic original proof loss");
            try { lease.finish(null, forbidden); throw new AssertionError("Unconfirmed session released"); }
            catch (AgentProtocolException expected) { }
            return Unit.INSTANCE;
        });
        var recovery = new HarmonyOsMaintenanceRecovery(root, tools, this::observe, this::transport,
            (directory, gate) -> { HarmonyOsSessionLeaseKt.writeGate(directory, gate); return Unit.INSTANCE; });
        write("prepared.json", recovery.prepare(DEVICE, owner).toMap());
        if (failObservation) {
            try { recovery.resume(DEVICE, owner); throw new AssertionError("Lost query released"); }
            catch (AgentProtocolException expected) { }
            int prior = calls;
            try { recovery.resume(DEVICE, owner); throw new AssertionError("Unknown query retried"); }
            catch (AgentProtocolException expected) { }
            if (calls != prior || !HarmonyOsSessionLease.Companion.requiresRecovery(DEVICE, root))
                throw new AssertionError("Unconfirmed call failed to block reuse");
        } else {
            write("resumed.json", recovery.resume(DEVICE, owner).toMap());
            var completed = recovery.complete(DEVICE, owner, Duration.ofSeconds(30));
            write("response.json", completed.toMap());
            int prior = calls;
            var again = recovery.complete(DEVICE, owner, Duration.ofSeconds(30));
            if (calls != prior || !again.getReceipt().getSha256().equals(completed.getReceipt().getSha256()))
                throw new AssertionError("Completed maintenance repeated cleanup");
        }
        write("input.json", Map.of("deviceId", DEVICE, "recoveryRoot", root.toString(),
            "createdAt", "2026-10-01T00:00:00.000Z", "responsePath", root.resolve(failObservation ? "prepared.json" : "response.json").toString()));
        write("producer.json", Map.of("synthetic", true, "deviceCalls", 0, "transportCalls", calls,
            "hostObservations", hosts, "scenario", failObservation ? "unconfirmed" : "complete"));
    }

    void write(String name, Object value) throws Exception {
        Files.write(root.resolve(name), JSON.writeValueAsBytes(value), StandardOpenOption.CREATE_NEW);
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 2 || !Set.of("complete", "unconfirmed").contains(args[1]))
            throw new IllegalArgumentException("NEW_OUTPUT_DIRECTORY complete|unconfirmed");
        new MaintenanceProducer(Path.of(args[0]).toAbsolutePath().normalize(), args[1].equals("unconfirmed")).run();
    }
}
