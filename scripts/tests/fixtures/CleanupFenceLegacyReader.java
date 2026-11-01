import maestro.cli.session.HarmonyOsSessionLease;
import maestro.cli.harmonyos.AgentProtocolException;
import java.nio.file.Path;

/** Run against the original frozen CLI to check that its gate reader refuses schema v3. */
class CleanupFenceLegacyReader {
    public static void main(String[] args) {
        try {
            HarmonyOsSessionLease.Companion.requiresRecovery("cleanup-fence-fixture", Path.of(args[0]));
            throw new AssertionError("Legacy reader accepted the retained-fence gate");
        } catch (AgentProtocolException expected) {
            System.out.println("Legacy reader refused retained-fence metadata.");
        }
    }
}
