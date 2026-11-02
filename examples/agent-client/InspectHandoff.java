import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.regex.Pattern;
import com.fasterxml.jackson.databind.*;
import maestro.orchestra.*;
import maestro.orchestra.yaml.YamlCommandReader;
import maestro.utils.FileAccessScope;

/** Uses the installed Maestro parser. No Orchestra, JavaScript engine, bridge or HDC is started. */
class InspectHandoff {
    static final ObjectMapper JSON = new ObjectMapper();
    static final Pattern VARIABLE = Pattern.compile("(?<!\\\\)\\$\\{\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*}");
    static final Map<String, Object> dependencies = new LinkedHashMap<>();
    static final Set<String> missing = new TreeSet<>();
    static FileAccessScope scope;
    static int visited;

    static void source(Path file, String parsed, String kind) throws Exception {
        file = file.toAbsolutePath().normalize();
        String name = file.getFileName().toString().toLowerCase(Locale.ROOT);
        if (!(kind.equals("yaml") ? name.endsWith(".yaml") || name.endsWith(".yml") : name.endsWith(".js")))
            throw new IllegalArgumentException("Handoff dependencies must be YAML or JS files: " + file);
        byte[] bytes = Files.readAllBytes(file);
        if (bytes.length > 4 * 1024 * 1024 || dependencies.size() >= 512)
            throw new IllegalArgumentException("Handoff source budget exceeded");
        if (parsed != null && !Arrays.equals(bytes, parsed.getBytes(StandardCharsets.UTF_8)))
            throw new IllegalArgumentException("Source changed during parsing or is not UTF-8: " + file);
        String sha = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        dependencies.put(file.toString(), Map.of("path", file.toString(), "sha256", sha, "kind", kind));
    }

    static void variables(JsonNode value, Set<String> defined) {
        if (value.isTextual()) {
            var matches = VARIABLE.matcher(value.asText());
            while (matches.find()) if (!defined.contains(matches.group(1))) missing.add(matches.group(1));
        } else if (value.isContainerNode()) value.forEach(child -> variables(child, defined));
    }

    static void collect(List<MaestroCommand> commands, Set<String> inherited, int depth) throws Exception {
        if (depth > 64) throw new IllegalArgumentException("Handoff command nesting budget exceeded");
        var defined = new HashSet<>(inherited);
        // Orchestra evaluates this level's DefineVariables commands before configuration and actions.
        for (var wrapped : commands) {
            if (wrapped.asCommand() instanceof DefineVariablesCommand definition) {
                variables(JSON.valueToTree(definition.getEnv()), defined);
                defined.addAll(definition.getEnv().keySet());
            }
        }
        for (var wrapped : commands) {
            if (++visited > 100000) throw new IllegalArgumentException("Handoff command count budget exceeded");
            var info = wrapped.getSourceInfo();
            if (info != null && info.getPath() != null) source(Path.of(info.getPath()), info.getSource(), "yaml");
            var command = wrapped.asCommand();
            if (command == null) continue;
            if (command instanceof DefineVariablesCommand) continue;
            // Check direct ${NAME} references only. Complex expressions and scripts remain runtime work.
            JsonNode fields = JSON.valueToTree(command);
            if (fields.isObject()) ((com.fasterxml.jackson.databind.node.ObjectNode) fields)
                .remove(List.of("commands", "config", "script", "scriptString", "originalDescription", "description"));
            variables(fields, defined);
            String child = command instanceof RunFlowCommand flow ? flow.getSourceDescription()
                : command instanceof RetryCommand retry ? retry.getSourceDescription() : null;
            if (child != null) {
                if (child.contains("${") || Path.of(child).isAbsolute()) throw new IllegalArgumentException("Handoff Flow paths must be static and relative");
                if (info == null || info.getPath() == null) throw new IllegalArgumentException("Child Flow has no source anchor");
                source(scope.resolve(Path.of(info.getPath()).toAbsolutePath().getParent(), child), null, "yaml");
            }
            if (command instanceof RunScriptCommand script) {
                if (script.getSourceDescription().contains("${") || Path.of(script.getSourceDescription()).isAbsolute() || script.getScriptDir() == null)
                    throw new IllegalArgumentException("Handoff script paths must be static and relative");
                source(Path.of(script.getScriptDir()).resolve(Path.of(script.getSourceDescription()).getFileName()), script.getScript(), "script");
            }
            MaestroConfig config = command instanceof ApplyConfigurationCommand applied ? applied.getConfig() : null;
            if (command instanceof CompositeCommand composite) {
                collect(composite.subCommands(), defined, depth + 1);
                config = composite.config();
            }
            if (command instanceof RetryCommand retry) config = retry.getConfig();
            if (config != null) {
                // Hooks run after child env setup; RunFlow config fields are evaluated in its caller.
                var configDefined = new HashSet<>(defined);
                if (command instanceof CompositeCommand composite) {
                    for (var item : composite.subCommands()) {
                        if (item.asCommand() instanceof DefineVariablesCommand definition) configDefined.addAll(definition.getEnv().keySet());
                    }
                }
                var fieldScope = command instanceof RunFlowCommand ? defined : configDefined;
                variables(JSON.valueToTree(config.getAppId()), fieldScope);
                variables(JSON.valueToTree(config.getName()), fieldScope);
                variables(JSON.valueToTree(config.getProperties()), fieldScope);
                if (config.getOnFlowStart() != null) collect(config.getOnFlowStart().getCommands(), configDefined, depth + 1);
                if (config.getOnFlowComplete() != null) collect(config.getOnFlowComplete().getCommands(), configDefined, depth + 1);
            }
        }
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 2) throw new IllegalArgumentException("REQUEST NEW_RESPONSE");
        var request = JSON.readTree(Path.of(args[0]).toFile());
        Path root = Path.of(request.get("sourceRoot").asText()).toAbsolutePath().normalize();
        Path file = Path.of(request.get("flow").asText()).toAbsolutePath().normalize();
        scope = FileAccessScope.Companion.under(root);
        if (!maestro.orchestra.workspace.FiltersKt.isFlowFile(file, null)) throw new IllegalArgumentException("Select one top-level Maestro YAML file");
        var commands = YamlCommandReader.INSTANCE.readCommands(file, scope);
        var defined = new HashSet<>(Set.of("output", "maestro", "http", "MAESTRO_FILENAME", "MAESTRO_DEVICE_UDID", "MAESTRO_SHARD_ID", "MAESTRO_SHARD_INDEX"));
        request.get("environmentNames").forEach(node -> defined.add(node.asText()));
        source(file, null, "yaml"); collect(commands, defined, 0);
        if (!missing.isEmpty()) throw new IllegalArgumentException("Missing handoff parameters (use --env NAME=value): " + missing);
        var config = YamlCommandReader.INSTANCE.getConfig(commands);
        String name = config != null && config.getName() != null ? config.getName() : file.getFileName().toString();
        var output = Map.of("protocol", "maestro.harmonyos.handoff-inspection", "schemaVersion", 1,
            "flow", file.toString(), "name", name, "dependencies", new ArrayList<>(dependencies.values()),
            "scriptsExecuted", false, "variableCheck", "direct_named_references");
        Files.writeString(Path.of(args[1]), JSON.writeValueAsString(output), StandardOpenOption.CREATE_NEW);
    }
}
