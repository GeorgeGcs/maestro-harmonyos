import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import maestro.orchestra.*;
import maestro.orchestra.yaml.YamlCommandReader;
import maestro.utils.FileAccessScope;

/** Parses with the installed Maestro reader. Never creates an Orchestra or evaluates JavaScript. */
class InspectFlows {
    private static final Map<String, Object> dependencies = new LinkedHashMap<>();
    private static int visited;
    private static FileAccessScope scope;

    private static void source(Path file, String parsed, String kind) throws Exception {
        file = file.toAbsolutePath().normalize();
        var name = file.getFileName().toString().toLowerCase(Locale.ROOT);
        if (!(kind.equals("yaml") ? name.endsWith(".yaml") || name.endsWith(".yml") : name.endsWith(".js")))
            throw new IllegalArgumentException("CI static dependencies must use YAML or JS extensions: " + file);
        var bytes = Files.readAllBytes(file);
        if (bytes.length > 4 * 1024 * 1024) throw new IllegalArgumentException("Static source exceeds 4 MiB: " + file);
        if (parsed != null && !Arrays.equals(bytes, parsed.getBytes(StandardCharsets.UTF_8)))
            throw new IllegalArgumentException("Source changed during parsing or is not consistent UTF-8: " + file);
        var digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        dependencies.put(file.toString(), Map.of("path", file.toString(), "sha256", digest, "kind", kind));
    }

    private static void collect(List<MaestroCommand> commands, int depth) throws Exception {
        if (depth > 64) throw new IllegalArgumentException("Static command tree is too deep");
        for (var command : commands) {
            if (++visited > 100000) throw new IllegalArgumentException("Too many static commands");
            var info = command.getSourceInfo();
            if (info != null && info.getPath() != null) source(Path.of(info.getPath()), info.getSource(), "yaml");
            var actual = command.asCommand();
            String childFile = actual instanceof RunFlowCommand flow ? flow.getSourceDescription()
                : actual instanceof RetryCommand retry ? retry.getSourceDescription() : null;
            if (childFile != null) {
                if (info == null || info.getPath() == null) throw new IllegalArgumentException("Referenced Flow has no source anchor");
                // Empty child Flows have no SourceInfo-bearing child commands.
                source(scope.resolve(Path.of(info.getPath()).toAbsolutePath().getParent(), childFile), null, "yaml");
            }
            if (actual instanceof RunScriptCommand script) {
                if (script.getScriptDir() == null) throw new IllegalArgumentException("Script file identity is unavailable");
                source(Path.of(script.getScriptDir()).resolve(Path.of(script.getSourceDescription()).getFileName()), script.getScript(), "script");
            }
            MaestroConfig config = null;
            if (actual instanceof ApplyConfigurationCommand applied) config = applied.getConfig();
            if (actual instanceof CompositeCommand composite) {
                collect(composite.subCommands(), depth + 1);
                config = composite.config();
            }
            if (actual instanceof RetryCommand retry) config = retry.getConfig();
            if (config != null) {
                if (config.getOnFlowStart() != null) collect(config.getOnFlowStart().getCommands(), depth + 1);
                if (config.getOnFlowComplete() != null) collect(config.getOnFlowComplete().getCommands(), depth + 1);
            }
        }
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 2) throw new IllegalArgumentException("Expected request and new output paths");
        var mapper = new ObjectMapper();
        var request = mapper.readTree(Files.readString(Path.of(args[0])));
        var root = Path.of(request.path("sourceRoot").asText()).toAbsolutePath().normalize();
        scope = FileAccessScope.Companion.under(root);
        var flows = new ArrayList<Object>();
        for (var flow : request.path("flows")) {
            var file = Path.of(flow.path("path").asText()).toAbsolutePath().normalize();
            if (!maestro.orchestra.workspace.FiltersKt.isFlowFile(file, null))
                throw new IllegalArgumentException("Declared top-level file is not selected as a native CLI Flow: " + file);
            var commands = YamlCommandReader.INSTANCE.readCommands(file, scope);
            var config = YamlCommandReader.INSTANCE.getConfig(commands);
            var fileName = file.getFileName().toString();
            var name = config != null && config.getName() != null ? config.getName() : fileName.substring(0, fileName.lastIndexOf('.'));
            if (!name.equals(flow.path("name").asText())) throw new IllegalArgumentException("Declared Flow name differs from Maestro configuration: " + file);
            source(file, null, "yaml"); collect(commands, 0);
            flows.add(Map.of("path", file.toString(), "name", name));
        }
        var output = Map.of("protocol", "maestro.harmonyos.ci-static-flows", "schemaVersion", 1, "flows", flows,
            "dependencies", new ArrayList<>(dependencies.values()));
        Files.writeString(Path.of(args[1]), mapper.writeValueAsString(output), StandardOpenOption.CREATE_NEW);
        System.out.println("CI_STATIC_FLOWS_PARSED; no commands or JavaScript executed");
    }
}
