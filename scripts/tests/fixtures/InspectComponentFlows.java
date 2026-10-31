import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import maestro.orchestra.*;
import maestro.orchestra.yaml.YamlCommandReader;
import maestro.utils.FileAccessScope;

/** Native parser only: no Orchestra, JavaScript evaluation or device session. */
class InspectComponentFlows {
    static void collect(List<MaestroCommand> commands, Map<String, TreeMap<Integer, Map<String,Object>>> grouped, int depth) throws Exception {
        if (depth > 64) throw new IllegalArgumentException("Nested command limit");
        for (var command : commands) {
            var source = command.getSourceInfo();
            var actual = command.asCommand();
            if (source != null && source.getPath() != null) {
                var entries = grouped.computeIfAbsent(source.getPath(), p -> new TreeMap<>());
                entries.putIfAbsent(source.getStartOffset(), new LinkedHashMap<>(Map.of(
                    "sourcePath", source.getPath(), "sourceOffset", source.getStartOffset(), "sourceLine", source.getStartLine(),
                    "commandName", actual == null ? "UnknownCommand" : actual.getClass().getSimpleName(),
                    "sourceSha256", HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                        .digest(source.getSource().getBytes(StandardCharsets.UTF_8))))));
            }
            MaestroConfig config = null;
            if (actual instanceof ApplyConfigurationCommand applied) config = applied.getConfig();
            if (actual instanceof CompositeCommand composite) { collect(composite.subCommands(), grouped, depth + 1); config = composite.config(); }
            if (actual instanceof RetryCommand retry) config = retry.getConfig();
            if (config != null) {
                if (config.getOnFlowStart() != null) collect(config.getOnFlowStart().getCommands(), grouped, depth + 1);
                if (config.getOnFlowComplete() != null) collect(config.getOnFlowComplete().getCommands(), grouped, depth + 1);
            }
        }
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 2) throw new IllegalArgumentException("COMPONENT_EXAMPLES_ROOT NEW_REPORT_PATH");
        Path root = Path.of(args[0]).toAbsolutePath().normalize();
        var scope = FileAccessScope.Companion.under(root);
        var flows = new ArrayList<Object>();
        for (String name : List.of("01-buttons.yaml", "02-dialogs.yaml", "03-input.yaml", "04-scroll.yaml")) {
            Set<String> plainSteps = new HashSet<>();
            for (String mode : List.of("flows", "recorded")) {
                Path file = root.resolve(mode).resolve(name);
                var commands = YamlCommandReader.INSTANCE.readCommands(file, scope);
                var grouped = new LinkedHashMap<String, TreeMap<Integer, Map<String,Object>>>();
                collect(commands, grouped, 0);
                List<Map<String,Object>> steps = new ArrayList<>();
                Set<String> identities = new HashSet<>();
                for (var entries : grouped.values()) {
                    int index = 0;
                    for (var step : entries.values()) {
                        step.put("commandIndex", index++); steps.add(step);
                        identities.add(step.get("sourcePath") + ":" + step.get("sourceOffset"));
                    }
                }
                if (mode.equals("flows")) plainSteps.addAll(identities);
                else {
                    if (!identities.containsAll(plainSteps)) throw new AssertionError("Recording wrapper lost scenario steps: " + name);
                    for (String kind : List.of("StartRecordingCommand", "StopRecordingCommand")) {
                        if (steps.stream().filter(s -> kind.equals(s.get("commandName"))).count() != 1)
                            throw new AssertionError("Expected exactly one " + kind + " in " + name);
                    }
                }
                flows.add(Map.of("path", file.toString(), "name", YamlCommandReader.INSTANCE.getConfig(commands).getName(), "steps", steps));
            }
        }
        Files.writeString(Path.of(args[1]), new ObjectMapper().writeValueAsString(Map.of(
            "flows", flows, "deviceCalls", 0, "scriptsExecuted", false)), StandardOpenOption.CREATE_NEW);
        System.out.println("Parsed 8 flows; all 4 recording wrappers retain their scenario steps. No execution.");
    }
}
