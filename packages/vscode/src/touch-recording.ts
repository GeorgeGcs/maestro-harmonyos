import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';

const execute = promisify(execFile);
const limit = 4 * 1024 * 1024;
const directory = '/data/local/tmp/maestro-touch';
const deviceSerial = /^[A-Za-z0-9_.:-]{1,128}$/;
const processCheck = `active() {
  processes=$(ps -eo args) || return 0
  printf '%s\\n' "$processes" | grep -q '^uitest uiRecord record[[:space:]]'
}`;

export async function verifyTouchIdle(hdc: string, serial: string): Promise<void> {
  if (!deviceSerial.test(serial) || /\.(bat|cmd)$/i.test(hdc)) throw new Error('HDC 路径或设备序列号无效。');
  const command = `${processCheck}
if test ! -e ${directory} && test ! -L ${directory} && ! active; then echo MAESTRO_IDLE; fi`;
  const { stdout } = await execute(hdc, ['-t', serial, 'shell', command], { timeout: 5000, windowsHide: true, maxBuffer: 4096 });
  if (stdout.trim() !== 'MAESTRO_IDLE') throw new Error('触摸录制仍在进行或设备留有录制状态，请核实后再执行这项操作。');
}

// The same shell that starts timeout asks it to stop its own child. The device
// deadline still applies if the host disappears. Leave ambiguous files in place.
function recordingCommand(token: string): string {
  return `
set -f
dir=${directory}
file=/data/local/tmp/record.csv
${processCheck}
if ! mkdir "$dir"; then echo MAESTRO_BUSY; exit 1; fi
if test -e "$file" || test -L "$file" || active; then rmdir "$dir"; echo MAESTRO_BUSY; exit 1; fi
echo '${token}' > "$dir/owner" || exit 1
echo MAESTRO_OWNED
sh -c '
  timer=$$
  request=$1
  (
    while test -d /proc/"$timer"; do
      if test -f "$request"; then kill -ALRM "$timer" 2>/dev/null; break; fi
      sleep 0.2
    done
  ) </dev/null >/dev/null 2>&1 &
  exec timeout -s INT -k 2s 120s uitest uiRecord record -W true -c true
' maestro-touch "$dir/${token}.stop"
if active; then echo MAESTRO_UNCONFIRMED; exit 1; fi
if test ! -e "$file" && test ! -L "$file"; then
  test "$(cat "$dir/owner")" = '${token}' || exit 1
  rm -f "$dir/${token}.stop" "$dir/owner" && rmdir "$dir" || exit 1
  echo MAESTRO_RELEASED
  exit 0
fi
if test ! -f "$file" || test -L "$file"; then echo MAESTRO_UNCONFIRMED; exit 1; fi
size=$(wc -c < "$file") || exit 1
if test "$size" -gt ${limit}; then echo MAESTRO_UNCONFIRMED; exit 1; fi
before=$(sha256sum "$file") || exit 1
# This UITest version writes JSON lines to record.csv. Read the owned file
# directly because uiRecord read can return empty after stopping the recorder.
echo MAESTRO_EVENTS
cat "$file" || exit 1
echo
after=$(sha256sum "$file") || exit 1
if test "$before" != "$after" || active || test "$(cat "$dir/owner")" != '${token}'; then echo MAESTRO_UNCONFIRMED; exit 1; fi
rm "$file" && rm -f "$dir/${token}.stop" "$dir/owner" && rmdir "$dir" || exit 1
echo MAESTRO_RELEASED
`;
}

export class TouchRecording {
  private readonly token = randomUUID();
  private readonly args: string[];
  private stopping?: Promise<void>;
  readonly result: Promise<{ events: string; released: boolean; started: boolean; busy: boolean; detail?: string }>;

  constructor(private readonly hdc: string, serial: string, app: string,
    onRecording: () => void, onCount: (count: number) => void, onProblem: (error: unknown) => void) {
    if (!deviceSerial.test(serial)) throw new Error('设备序列号无效。');
    if (/\.(bat|cmd)$/i.test(hdc)) throw new Error('请配置原生 HDC 可执行文件。');
    this.args = ['-t', serial, 'shell'];
    const child = spawn(hdc, [...this.args, recordingCommand(this.token)],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.result = new Promise((resolve, reject) => {
      const decoder = new StringDecoder('utf8');
      let tail = '', events = '', count = 0, bytes = 0;
      let detail: string | undefined;
      let matched = false, started = false, owned = false, reading = false, released = false, busy = false;
      const inspect = (line: string) => {
        if (line === 'MAESTRO_OWNED') owned = true;
        if (line === 'MAESTRO_BUSY') busy = true;
        if (line.startsWith('Current ForAbility :')) {
          matched = line.slice('Current ForAbility :'.length).split(',')[0].trim() === app;
          if (!matched) { detail = '当前前台应用与所选应用不一致。'; void this.stop().catch(onProblem); }
        }
        if (line.startsWith('Started Recording Successfully') && matched && owned) { started = true; onRecording(); }
        if (line === 'MAESTRO_EVENTS') { reading = true; return; }
        if (line === 'MAESTRO_RELEASED') { released = true; reading = false; return; }
        if (reading && line.trim()) events += line + '\n';
        if (!reading && !detail && /error|fail|denied/i.test(line) && !line.startsWith('Started Recording Successfully')) detail = line.slice(0, 250);
        if (!reading && started && /\b(?:click|swipe|fling)\s*,\s*fingerNumber:\s*1\s*(?:,|$)/.test(line)) onCount(++count);
      };
      const deadline = setTimeout(() => { child.kill(); reject(new Error('录制连接超时，设备释放未确认。')); }, 132000);
      child.stdout.on('data', (data: Buffer) => {
        bytes += data.length;
        if (bytes > limit * 2) { void this.stop().catch(onProblem); return; }
        const lines = (tail + decoder.write(data)).split('\n');
        tail = lines.pop() ?? '';
        for (const line of lines) inspect(line.trimEnd());
      });
      child.stderr.on('data', (data: Buffer) => { detail ??= data.toString('utf8').trim().slice(0, 250) || undefined; });
      child.once('error', error => { clearTimeout(deadline); reject(error); });
      child.once('close', code => {
        clearTimeout(deadline);
        if (tail) inspect((tail + decoder.end()).trimEnd());
        resolve({ events, released: code === 0 && released && bytes <= limit * 2, started, busy, detail });
      });
    });
  }

  stop(): Promise<void> {
    this.stopping ??= this.requestStop().catch(error => { this.stopping = undefined; throw error; });
    return this.stopping;
  }

  private async requestStop(): Promise<void> {
    const command = `dir=${directory}; token='${this.token}'; i=0;
while test "$i" -lt 15; do
  if test "$(cat "$dir/owner" 2>/dev/null)" = "$token"; then
    touch "$dir/$token.stop" && echo MAESTRO_STOP_REQUESTED; exit
  fi
  i=$((i+1)); sleep 0.2
done`;
    const { stdout } = await execute(this.hdc, [...this.args, command], { timeout: 5000, windowsHide: true, maxBuffer: 4096 });
    if (!stdout.trim().split(/\r?\n/).includes('MAESTRO_STOP_REQUESTED')) throw new Error('没有收到设备停止请求回执。');
  }
}
