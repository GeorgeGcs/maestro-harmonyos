import com.fasterxml.jackson.databind.*;
import maestro.harmonyos.hdc.*;
import maestro.cli.session.HarmonyOsSessionSupport;
import kotlin.Unit;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.security.MessageDigest;

/** Research fixture only. No release, recovery, application, or recording API is invoked. */
class CleanupFenceProbe {
    static final ObjectMapper JSON = new ObjectMapper();
    final boolean device;
    final Path output;
    final String executable, target;
    final AtomicInteger sequence = new AtomicInteger();
    final List<Map<String,Object>> results = new ArrayList<>();
    final HdcClient hdc;
    CleanupFenceProbe(boolean device, Path output, String executable, String target) throws Exception {
        this.device=device; this.output=output; this.executable=executable; this.target=target;
        Files.createDirectory(output);
        hdc=new HdcClient(executable,new ProcessHdcCommandRunner(),Duration.ofSeconds(15),null,false);
    }
    static String quote(String text) { return "'"+text.replace("'","'\"'\"'")+"'"; }
    static String hash(byte[] bytes) throws Exception { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
    void save(String name,Object value) throws Exception { Files.write(output.resolve(name),JSON.writerWithDefaultPrettyPrinter().writeValueAsBytes(value),StandardOpenOption.CREATE_NEW); }
    record Result(int exit,String out,String err) {}
    Result run(String script) throws Exception {
        int n=sequence.incrementAndGet();
        save("command-"+n+".json",Map.of("script",script,"device",device));
        Result result;
        if(device) {
            String marker="PROBE_EXIT_"+UUID.randomUUID().toString().replace("-","")+"=";
            String wrapper="sh -c "+quote(script)+"; __probe_status=$?; printf '\\n"+marker+"%s\\n' \"$__probe_status\"";
            HdcCommandResult r=hdc.shell(target,List.of("sh","-c",wrapper),Duration.ofSeconds(15));
            String out=r.getStdout(); int at=out.lastIndexOf("\n"+marker);
            if(at<0) throw new IllegalStateException("Probe completion proof missing; retain fixture directory");
            String status=out.substring(at+marker.length()+1).trim();
            if(!status.matches("[0-9]{1,3}")) throw new IllegalStateException("Invalid probe completion proof");
            result=new Result(Integer.parseInt(status),out.substring(0,at),r.getStderr());
        } else {
            Path stdout=output.resolve("stdout-"+n+".txt"),stderr=output.resolve("stderr-"+n+".txt");
            Path source=output.resolve("command-"+n+".sh");
            Files.writeString(source,script+"\n",StandardOpenOption.CREATE_NEW);
            Process process=new ProcessBuilder(executable,source.toString().replace('\\','/')).directory(output.toFile())
                .redirectOutput(stdout.toFile()).redirectError(stderr.toFile()).start();
            if(!process.waitFor(15,TimeUnit.SECONDS)) { process.destroyForcibly().waitFor(); throw new IllegalStateException("Host probe timed out"); }
            result=new Result(process.exitValue(),Files.readString(stdout),Files.readString(stderr));
        }
        save("result-"+n+".json",Map.of("exit",result.exit,"stdout",result.out,"stderr",result.err));
        return result;
    }
    void success(String script) throws Exception { Result r=run(script); if(r.exit!=0) throw new IllegalStateException("Probe command failed: "+r); }
    record Scope(String root,String file,String operation,String wrapped) {}
    Scope scope(String name) throws Exception {
        Path journalPath=output.resolve(name+"-journal.json");
        String[] captured={null}; String remote;
        try(var journal=HarmonyOSRecoveryJournal.Companion.create(journalPath,"probe-target",UUID.randomUUID().toString())) {
            remote=journal.allocateTemporaryFile$maestro_client("layout","json");
            var capture=new HdcClient("capture-only",(command,timeout)-> {
                captured[0]=command.get(command.size()-1); return new HdcCommandResult(0,"captured, not dispatched","");
            },Duration.ofSeconds(3),null,false).withRecoveryJournal(journal);
            try { capture.shell("probe-target",List.of("rm","-f",remote),Duration.ofSeconds(3)); throw new AssertionError("Missing proof accepted"); }
            catch(HdcException expected) { }
        }
        JsonNode journal=JSON.readTree(journalPath.toFile());
        String root=journal.get("remoteRoot").asText();
        String prefix="'sh' '-c' '";
        if(captured[0]==null||!captured[0].startsWith(prefix)||!captured[0].endsWith("'")) throw new IllegalStateException("Unexpected production wrapper encoding");
        String wrapped=captured[0].substring(prefix.length(),captured[0].length()-1).replace("'\"'\"'","'");
        String op=root+"/"+journal.get("operations").get(0).get("id").asText();
        if(!wrapped.contains("mkdir "+quote(op)+" || exit 119; ")) throw new IllegalStateException("Production wrapper lacks exclusive dispatch barrier");
        if(!device){String local="./"+name;wrapped=wrapped.replace(root,local);remote=remote.replace(root,local);op=op.replace(root,local);root=local;}
        save(name+"-scope.json",Map.of("root",root,"file",remote,"operation",op,"productionWrapper",wrapped,"adaptedPathsForHost",!device));
        success("umask 077; [ ! -e "+quote(root)+" ] && [ ! -L "+quote(root)+" ] && mkdir "+quote(root)+" && mkdir "+quote(root+"/files")+" && printf payload > "+quote(remote));
        return new Scope(root,remote,op,wrapped);
    }
    String fence(Scope s,boolean marker) {
        return "[ ! -L "+quote(s.root)+" ] && [ -d "+quote(s.root)+" ] && [ ! -L "+quote(s.root+"/files")+" ] && [ -d "+quote(s.root+"/files")+" ] || exit 122; "+
            "mkdir "+quote(s.operation)+" || exit 123; "+(marker?"printf owned > "+quote(s.operation+"/fence")+" || exit 124; printf FENCED":"exit 124");
    }
    void blocked(Scope s) throws Exception { if(run(s.wrapped).exit!=119) throw new AssertionError("Late production command crossed the fence"); }
    void exists(Scope s) throws Exception { success("[ -f "+quote(s.file)+" ] && [ \"$(cat "+quote(s.file)+")\" = payload ]"); }
    void clean(Scope s) throws Exception {
        // Only called after every injected command has returned; never used on a real blocked session.
        success("rm -f "+quote(s.file)+" "+quote(s.operation+"/fence")+" "+quote(s.operation+"/done")+" "+quote(s.operation+"/done.pending")+
            " && rmdir "+quote(s.operation)+" && rmdir "+quote(s.root+"/files")+" && rmdir "+quote(s.root));
    }
    void record(String name) { results.add(Map.of("scenario",name,"passed",true)); }
    void tests() throws Exception {
        Scope first=scope("fence-first");
        Result fenced=run(fence(first,true));
        if(fenced.exit!=0||!fenced.out.stripTrailing().equals("FENCED")) throw new AssertionError("Fence not acknowledged");
        blocked(first); exists(first);
        success("rm -f "+quote(first.file)); blocked(first);
        // Distinct generations can proceed while the old dispatch barrier remains in place.
        Scope next=scope("next-generation"); success(next.wrapped); success("[ ! -e "+quote(next.file)+" ]");
        blocked(first); clean(next); clean(first); record("fence wins, repeated late dispatch refused, next generation independent");

        Scope old=scope("original-first"); success(old.wrapped);
        if(run(fence(old,true)).exit!=123) throw new AssertionError("Existing operation was adopted");
        success("[ ! -e "+quote(old.file)+" ] && [ -f "+quote(old.operation+"/done")+" ]");
        clean(old); record("original wins, recovery refuses adoption");

        Scope interrupted=scope("interrupted-fence");
        if(run(fence(interrupted,false)).exit!=124) throw new AssertionError("Fault injection failed");
        if(run(fence(interrupted,true)).exit!=123) throw new AssertionError("Unconfirmed fence was adopted");
        blocked(interrupted); exists(interrupted); clean(interrupted); record("fault after mkdir before marker: unconfirmed directory is not adopted");

        // Exercise native device symlinks; Git Bash may emulate them as copies on Windows.
        if(device) {
        Scope linked=scope("operation-symlink");
        success("ln -s "+quote(linked.file)+" "+quote(linked.operation));
        if(run(fence(linked,true)).exit!=123) throw new AssertionError("Existing symlink was adopted");
        blocked(linked); exists(linked);
        success("rm "+quote(linked.operation)+" && mkdir "+quote(linked.operation));
        clean(linked); record("operation symlink refused by both paths");

        Scope parent=scope("files-symlink");
        success("rm "+quote(parent.file)+" && rmdir "+quote(parent.root+"/files")+" && ln -s . "+quote(parent.root+"/files"));
        if(run(fence(parent,true)).exit!=122) throw new AssertionError("Symlink parent accepted");
        blocked(parent);
        success("rm "+quote(parent.root+"/files")+" && mkdir "+quote(parent.root+"/files")+" && mkdir "+quote(parent.operation));
        clean(parent); record("files parent symlink refused by both paths");
        }

        Scope removed=scope("removed-fence-control"); success(fence(removed,true)); blocked(removed);
        success("rm -f "+quote(removed.operation+"/fence")+" && rmdir "+quote(removed.operation));
        success(removed.wrapped); success("[ ! -e "+quote(removed.file)+" ]"); clean(removed);
        record("negative control: removing fence permits delayed command");

        for(int i=0;i<(device?4:20);i++) {
            Scope s=scope("race-"+i); var workers=Executors.newFixedThreadPool(2); var start=new CountDownLatch(1);
            try {
                Future<Result> a=workers.submit(()->{start.await();return run(s.wrapped);});
                Future<Result> b=workers.submit(()->{start.await();return run(fence(s,true));}); start.countDown();
                Result original=a.get(20,TimeUnit.SECONDS),claim=b.get(20,TimeUnit.SECONDS);
                boolean fenceWon=claim.exit==0&&original.exit==119;
                boolean originalWon=original.exit==0&&claim.exit==123;
                if(!fenceWon&&!originalWon) throw new AssertionError("Race did not have exactly one winner");
                if(fenceWon) exists(s); else success("[ ! -e "+quote(s.file)+" ]");
                clean(s); record("race-"+i+":"+(fenceWon?"fence":"original"));
            } finally {workers.shutdownNow(); if(!workers.awaitTermination(20,TimeUnit.SECONDS)) throw new IllegalStateException("Probe workers still active");}
        }
    }
    void deviceTests() throws Exception {
        Path locks=Path.of(System.getProperty("user.home"),".maestro","harmonyos-sessions");
        HarmonyOsSessionSupport.INSTANCE.withDeviceLock$maestro_cli(target,locks,()->{
            try {
                Path gatePath=locks.resolve(hash(target.getBytes(java.nio.charset.StandardCharsets.UTF_8))+".owner.json");
                byte[] before=Files.readAllBytes(gatePath); JsonNode gate=JSON.readTree(before);
                if(!gate.get("state").asText().equals("quarantined")||gate.hasNonNull("maintenance")) throw new IllegalStateException("Unexpected actual lease state");
                Path journal=Path.of(gate.get("journalPath").asText()); byte[] original=Files.readAllBytes(journal);
                save("actual-scope-before.json",Map.of("gateSha256",hash(before),"journalSha256",hash(original),"operation","isolated filesystem probe only"));
                try {hdc.selectDevice(target);tests();}
                finally {
                    boolean unchanged=Arrays.equals(before,Files.readAllBytes(gatePath))&&Arrays.equals(original,Files.readAllBytes(journal));
                    save("actual-scope-after.json",Map.of("unchanged",unchanged));
                    if(!unchanged) throw new IllegalStateException("Actual blocked lease changed");
                }
                return Unit.INSTANCE;
            }catch(Exception error){throw new RuntimeException(error);}
        });
    }
    public static void main(String[] args) throws Exception {
        if(args.length<3||!Set.of("host","device").contains(args[0])||args[0].equals("device")&&args.length!=4) throw new IllegalArgumentException("host NEW_OUTPUT SHELL | device NEW_OUTPUT HDC DEVICE");
        boolean device=args[0].equals("device");
        var probe=new CleanupFenceProbe(device,Path.of(args[1]).toAbsolutePath().normalize(),args[2],device?args[3]:null);
        try {
            if(device)probe.deviceTests();else probe.tests();
            var summary=Map.of("passed",true,"prototypeOnly",true,"actualSessionReleased",false,"device",device,"scenarios",probe.results);
            probe.save("summary.json",summary); System.out.println(JSON.writeValueAsString(summary));
        }catch(Exception|AssertionError error){probe.save("failure.json",Map.of("message",error.toString(),"completed",probe.results));throw error;}
    }
}
