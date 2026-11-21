import com.fasterxml.jackson.databind.*;
import java.nio.file.*;import java.time.Instant;import java.util.*;
import maestro.cli.harmonyos.HarmonyOsRecorderBackend;
import maestro.harmonyos.hdc.HarmonyOSDiagnosticCompletionRecovery;
/** Explicit operator-reviewed legacy diagnostic recovery. It never submits a Flow. */
class RecoverReviewedFaultQuery {
 public static void main(String[] args)throws Exception{
  if(args.length!=2)throw new IllegalArgumentException("Usage: scope.json new-response.json; review original query source and trace before invoking");
  Path input=Path.of(args[0]),output=Path.of(args[1]);if(Files.size(input)>16384||!Files.isRegularFile(input,LinkOption.NOFOLLOW_LINKS)||Files.exists(output))throw new IllegalArgumentException("Invalid scope input or output exists");
  ObjectMapper mapper=new ObjectMapper();JsonNode s=mapper.readTree(Files.readAllBytes(input));
  Set<String> fields=new HashSet<>();s.fieldNames().forEachRemaining(fields::add);
  if(!fields.equals(Set.of("deviceId","sessionId","operationId","commandSha256","tracePath","traceSha256")))throw new IllegalArgumentException("Unexpected recovery scope fields");
  for(String f:fields)if(!s.path(f).isTextual()||s.path(f).asText().isBlank())throw new IllegalArgumentException("Invalid recovery scope field");
  var data=HarmonyOSDiagnosticCompletionRecovery.withReviewedFaultQuery(s.path("deviceId").asText(),s.path("sessionId").asText(),s.path("operationId").asText(),s.path("commandSha256").asText(),Path.of(s.path("tracePath").asText()),s.path("traceSha256").asText(),()->new HarmonyOsRecorderBackend().recover(s.path("deviceId").asText(),s.path("sessionId").asText()));
  var report=Map.of("protocol","maestro.harmonyos.agent","schemaVersion",2,"kind","recoveryReport","revision",1,"observedAt",Instant.now().toString(),"data",data);
  Files.writeString(output,mapper.writerWithDefaultPrettyPrinter().writeValueAsString(report),StandardOpenOption.CREATE_NEW);System.out.println(mapper.writeValueAsString(report));
  if(!Boolean.TRUE.equals(data.get("handoffReady")))System.exit(2);
 }
}
