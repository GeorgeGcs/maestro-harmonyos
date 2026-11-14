import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';

const execute = promisify(execFile);
const limit = 4 * 1024 * 1024;
const directory = '/data/local/tmp/maestro-touch';
const recordFile = '/data/local/tmp/record.csv';
const deviceSerial = /^[A-Za-z0-9_.:-]{1,128}$/;
const ownerPattern = '[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const processCheck = `active() {
  processes=$(ps -eo args) || return 0
  printf '%s\\n' "$processes" | grep -Eq '^([^[:space:]]*/)?(timeout -s INT -k 2s 120s )?uitest uiRecord record([[:space:]]|$)'
}`;

type ArchiveRecording = (events: Buffer) => Promise<void>;

// Older versions did not hold a lock. Require their stop marker and wait out
// their original HDC deadline before treating the directory as abandoned.
const withStoppedRecording = `set -f
dir=${directory}
file=${recordFile}
${processCheck}
if active; then exit 1; fi
if test ! -e "$dir" && test ! -L "$dir"; then
  echo MAESTRO_IDLE
  exit 0
fi
test -d "$dir" && test ! -L "$dir" || exit 1
(
  flock -xn 9 || exit 1
  on_disk=$(stat -c '%d:%i' "$dir") && locked=$(stat -Lc '%d:%i' /proc/self/fd/9) || exit 1
  test "$on_disk" = "$locked" || exit 1
  test -f "$dir/owner" && test ! -L "$dir/owner" || exit 1
  owner=$(cat "$dir/owner") || exit 1
  printf '%s\\n' "$owner" | grep -Eq '^${ownerPattern}$' || exit 1
  if test -e "$dir/managed" || test -L "$dir/managed"; then
    test -f "$dir/managed" && test ! -L "$dir/managed" && test "$(cat "$dir/managed")" = "$owner" || exit 1
  else
    test -f "$dir/$owner.stop" && test ! -L "$dir/$owner.stop" || exit 1
    started=$(stat -c '%Y' "$dir/owner") && now=$(date +%s) || exit 1
    test "$((now - started))" -ge 132 || exit 1
  fi
  entries=$(ls -A "$dir") || exit 1
  if printf '%s\\n' "$entries" | grep -Ev "^(owner|managed|$owner[.]stop)$" | grep -q .; then exit 1; fi
  if active; then exit 1; fi
  fingerprint() {
    if test ! -e "$file" && test ! -L "$file"; then echo absent; return; fi
    test -f "$file" && test ! -L "$file" || return 1
    size=$(wc -c < "$file") && test "$size" -le ${limit} || return 1
    inode=$(stat -c '%d:%i' "$file") && sum=$(sha256sum "$file") || return 1
    printf '%s:%s\\n' "$inode" "\${sum%% *}"
  }
  before=$(fingerprint) || exit 1`;

export async function verifyTouchIdle(hdc: string, serial: string, archive: ArchiveRecording,
  expectedOwner?: string): Promise<{ recovered: boolean; events: Buffer }> {
  if (!deviceSerial.test(serial) || /\.(bat|cmd)$/i.test(hdc)) throw new Error('HDC 路径或设备序列号无效。');
  const read = `${withStoppedRecording}
  printf 'MAESTRO_CAPTURE\\n%s\\n%s\\n' "$owner" "$before"
  if test "$before" != absent; then base64 -w 0 "$file" || exit 1; fi
  echo
  test "$before" = "$(fingerprint)" && ! active || exit 1
  echo MAESTRO_CAPTURE_END
) 9<"$dir"`;
  const shell = async (command: string) => {
    try {
      const { stdout } = await execute(hdc, ['-t', serial, 'shell', command],
        { timeout: 15000, windowsHide: true, maxBuffer: Math.ceil(limit * 4 / 3) + 4096 });
      return stdout;
    } catch {
      throw new Error('触摸录制仍在进行或无法确认遗留状态。请等待录制结束后重试。');
    }
  };
  const lines = (await shell(read)).trimEnd().split(/\r?\n/);
  if (lines.length === 1 && lines[0] === 'MAESTRO_IDLE') return { recovered: false, events: Buffer.alloc(0) };
  const [marker, owner, fingerprint, encoded, end] = lines;
  const events = Buffer.from(encoded ?? '', 'base64');
  const digest = createHash('sha256').update(events).digest('hex');
  if (marker !== 'MAESTRO_CAPTURE' || !new RegExp(`^${ownerPattern}$`).test(owner) ||
      (expectedOwner && expectedOwner !== owner) || lines.length !== 5 || end !== 'MAESTRO_CAPTURE_END' ||
      events.toString('base64') !== encoded ||
      (fingerprint === 'absent' ? events.length !== 0 : !new RegExp(`^\\d+:\\d+:${digest}$`).test(fingerprint))) {
    throw new Error('触摸录制仍在进行或无法核对录制文件。设备上的文件已保留。');
  }
  if (events.length) await archive(events);
  const release = `${withStoppedRecording}
  test "$owner" = '${owner}' && test "$before" = '${fingerprint}' || exit 1
  retired="$dir.$owner.released"
  test ! -e "$retired" && test ! -L "$retired" || exit 1
  if active; then exit 1; fi
  if test "$before" != absent; then rm "$file" || exit 1; fi
  # Release the guard with a single rename, even if deleting its markers is interrupted.
  mv -T "$dir" "$retired" || exit 1
  rm -f "$retired/$owner.stop" "$retired/managed" "$retired/owner" && rmdir "$retired"
  echo MAESTRO_IDLE
) 9<"$dir"`;
  if ((await shell(release).catch(() => '')).trim() !== 'MAESTRO_IDLE') {
    throw new Error('录制已取回，设备释放未确认。');
  }
  return { recovered: true, events };
}

// The same shell that starts timeout asks it to stop its own child. The device
// deadline still applies if the host disappears. Leave ambiguous files in place.
function recordingCommand(token: string): string {
  return `
set -f
dir=${directory}
file=${recordFile}
${processCheck}
if ! mkdir "$dir"; then echo MAESTRO_BUSY; exit 1; fi
(
  flock -xn 9 || exit 1
  if test -e "$file" || test -L "$file" || active; then rmdir "$dir"; echo MAESTRO_BUSY; exit 1; fi
  echo '${token}' > "$dir/managed" && echo '${token}' > "$dir/owner" || exit 1
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
) 9<"$dir"
`;
}

export class TouchRecording {
  private readonly token = randomUUID();
  private readonly args: string[];
  private stopping?: Promise<void>;
  readonly result: Promise<{ events: string; released: boolean; started: boolean; busy: boolean; detail?: string }>;

  constructor(private readonly hdc: string, serial: string, app: string,
    onRecording: () => void, onCount: (count: number) => void, onProblem: (error: unknown) => void,
    archive: ArchiveRecording) {
    if (!deviceSerial.test(serial)) throw new Error('设备序列号无效。');
    if (/\.(bat|cmd)$/i.test(hdc)) throw new Error('请配置原生 HDC 可执行文件。');
    this.args = ['-t', serial, 'shell'];
    const child = spawn(hdc, [...this.args, recordingCommand(this.token)],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.result = new Promise((resolve, reject) => {
      const decoder = new StringDecoder('utf8');
      let tail = '', count = 0, bytes = 0;
      let detail: string | undefined;
      let matched = false, started = false, owned = false, busy = false;
      const inspect = (line: string) => {
        if (line === 'MAESTRO_OWNED') owned = true;
        if (line === 'MAESTRO_BUSY') busy = true;
        if (line.startsWith('Current ForAbility :')) {
          matched = line.slice('Current ForAbility :'.length).split(',')[0].trim() === app;
          if (!matched) { detail = '当前前台应用与所选应用不一致。'; void this.stop().catch(onProblem); }
        }
        if (line.startsWith('Started Recording Successfully') && matched && owned) { started = true; onRecording(); }
        if (!detail && /error|fail|denied/i.test(line) && !line.startsWith('Started Recording Successfully')) detail = line.slice(0, 250);
        if (started && /\b(?:click|swipe|fling)\s*,\s*fingerNumber:\s*1\s*(?:,|$)/.test(line)) onCount(++count);
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
      child.once('close', () => {
        clearTimeout(deadline);
        if (tail) inspect((tail + decoder.end()).trimEnd());
        if (!owned) { resolve({ events: '', released: false, started, busy, detail }); return; }
        void verifyTouchIdle(hdc, serial, archive, this.token).then(
          result => resolve({ events: result.events.toString('utf8'), released: true, started, busy, detail }),
          reject,
        );
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
