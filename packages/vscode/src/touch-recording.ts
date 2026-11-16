import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { TouchLayouts, touchLayoutName } from './touch-import';

const execute = promisify(execFile);
const limit = 4 * 1024 * 1024;
const layoutTotalLimit = 8 * 1024 * 1024;
const directory = '/data/local/tmp/maestro-touch';
const recordFile = '/data/local/tmp/record.csv';
const deviceSerial = /^[A-Za-z0-9_.:-]{1,128}$/;
const ownerPattern = '[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const layoutPattern = 'layout_[0-9]{10,20}_[0-9]{1,6}[.]json';
const processCheck = `active() {
  processes=$(ps -eo args) || return 0
  printf '%s\\n' "$processes" | grep -Eq '^([^[:space:]]*/)?(timeout -s INT -k 2s 120s )?uitest uiRecord record([[:space:]]|$)'
}`;

type ArchiveRecording = (events: Buffer, layouts: TouchLayouts) => Promise<void>;

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
  if printf '%s\\n' "$entries" | grep -Ev "^(owner|managed|initial[.]json|${layoutPattern}|$owner[.]stop)$" | grep -q .; then exit 1; fi
  if active; then exit 1; fi
  fingerprint() {
    test -f "$1" && test ! -L "$1" || return 1
    inode=$(stat -c '%d:%i' "$1") && sum=$(sha256sum "$1") || return 1
    printf '%s:%s\\n' "$inode" "\${sum%% *}"
  }
  record_fingerprint() {
    if test ! -e "$file" && test ! -L "$file"; then echo absent; return; fi
    test -f "$file" && test ! -L "$file" || return 1
    size=$(wc -c < "$file") && test "$size" -le ${limit} || return 1
    fingerprint "$file"
  }
  layout_names=$(printf '%s\\n' "$entries" | grep -Ex 'initial[.]json|${layoutPattern}')
  layout_inventory() {
    for name in $layout_names; do
      proof=$(fingerprint "$dir/$name") || return 1
      printf '%s %s\\n' "$name" "$proof"
    done
  }
  before=$(record_fingerprint) && inventory=$(layout_inventory) || exit 1
  inventory_sum=$(printf '%s' "$inventory" | sha256sum) || exit 1`;

export async function verifyTouchIdle(hdc: string, serial: string, archive: ArchiveRecording,
  expectedOwner?: string): Promise<{ recovered: boolean; events: Buffer; layouts: TouchLayouts }> {
  if (!deviceSerial.test(serial) || /\.(bat|cmd)$/i.test(hdc)) throw new Error('HDC 路径或设备序列号无效。');
  const read = `${withStoppedRecording}
  printf 'MAESTRO_CAPTURE\\n%s\\n%s\\n' "$owner" "$before"
  if test "$before" != absent; then base64 -w 0 "$file" || exit 1; fi
  echo
  total=0
  for name in $layout_names; do
    source="$dir/$name"
    proof=$(fingerprint "$source") && size=$(wc -c < "$source") || exit 1
    if test "$size" -gt ${limit} || test "$((total + size))" -gt ${layoutTotalLimit}; then continue; fi
    total=$((total + size))
    printf 'MAESTRO_LAYOUT %s %s ' "$name" "$proof"
    base64 -w 0 "$source" || exit 1
    echo
  done
  test "$before" = "$(record_fingerprint)" && test "$inventory" = "$(layout_inventory)" && ! active || exit 1
  printf 'MAESTRO_CAPTURE_END %s\\n' "\${inventory_sum%% *}"
) 9<"$dir"`;
  const shell = async (command: string) => {
    try {
      const { stdout } = await execute(hdc, ['-t', serial, 'shell', command],
        { timeout: 20000, windowsHide: true, maxBuffer: Math.ceil((limit + layoutTotalLimit) * 4 / 3) + 256 * 1024 });
      return stdout;
    } catch {
      throw new Error('触摸录制仍在进行或无法确认遗留状态。请等待录制结束后重试。');
    }
  };
  const lines = (await shell(read)).trimEnd().split(/\r?\n/);
  const layouts: TouchLayouts = { after: {} };
  if (lines.length === 1 && lines[0] === 'MAESTRO_IDLE') return { recovered: false, events: Buffer.alloc(0), layouts };
  const [marker, owner, fingerprint, encoded] = lines;
  const inventoryDigest = /^MAESTRO_CAPTURE_END ([a-f0-9]{64})$/.exec(lines.at(-1) ?? '')?.[1];
  const events = Buffer.from(encoded ?? '', 'base64');
  const digest = createHash('sha256').update(events).digest('hex');
  if (marker !== 'MAESTRO_CAPTURE' || !new RegExp(`^${ownerPattern}$`).test(owner) ||
      (expectedOwner && expectedOwner !== owner) || !inventoryDigest ||
      events.toString('base64') !== encoded ||
      (fingerprint === 'absent' ? events.length !== 0 : !new RegExp(`^\\d+:\\d+:${digest}$`).test(fingerprint))) {
    throw new Error('触摸录制仍在进行或无法核对录制文件。设备上的文件已保留。');
  }
  for (const line of lines.slice(4, -1)) {
    const fields = /^MAESTRO_LAYOUT ([\w.]+) \d+:\d+:([a-f0-9]{64}) ([A-Za-z0-9+/=]*)$/.exec(line);
    if (!fields) throw new Error('设备上的录制控件树未能核对。');
    const [, name, hash, encodedLayout] = fields;
    if (name !== 'initial.json' && !touchLayoutName(`/data/local/tmp/${name}`)) throw new Error('录制控件树路径无效。');
    const bytes = Buffer.from(encodedLayout, 'base64');
    if (bytes.toString('base64') !== encodedLayout || createHash('sha256').update(bytes).digest('hex') !== hash) {
      throw new Error('设备上的录制控件树未能核对。');
    }
    // A partial native JSON dump cannot establish selector uniqueness. Keep the event coordinates.
    let tree: unknown;
    try { tree = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { continue; }
    if (name === 'initial.json') layouts.initial = tree;
    else layouts.after[name] = tree;
  }
  if (events.length) await archive(events, layouts);
  const release = `${withStoppedRecording}
  test "$owner" = '${owner}' && test "$before" = '${fingerprint}' &&
    test "\${inventory_sum%% *}" = '${inventoryDigest}' || exit 1
  retired="$dir.$owner.released"
  test ! -e "$retired" && test ! -L "$retired" || exit 1
  if active; then exit 1; fi
  if test "$before" != absent; then rm "$file" || exit 1; fi
  # Release the guard with a single rename, even if deleting its markers is interrupted.
  mv -T "$dir" "$retired" || exit 1
  for name in $layout_names; do rm -f "$retired/$name" || exit 1; done
  rm -f "$retired/$owner.stop" "$retired/managed" "$retired/owner" && rmdir "$retired" || exit 1
  echo MAESTRO_IDLE
) 9<"$dir"`;
  if ((await shell(release).catch(() => '')).trim() !== 'MAESTRO_IDLE') {
    throw new Error('录制已取回，设备释放未确认。');
  }
  return { recovered: true, events, layouts };
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
  timeout -k 1s 4s uitest dumpLayout -p "$dir/initial.json" >/dev/null 2>&1 || true
  set --
  if uitest help 2>/dev/null | grep -q 'Save the current layout information after each operation' &&
     existing=$(find /data/local/tmp -maxdepth 1 -name 'layout_*.json' -print); then
    set -- -l
  fi
  sh -c '
  timer=$$
  request=$1
  shift
  (
    while test -d /proc/"$timer"; do
      if test -f "$request"; then kill -ALRM "$timer" 2>/dev/null; break; fi
      sleep 0.2
    done
  ) </dev/null >/dev/null 2>&1 &
  exec timeout -s INT -k 2s 120s uitest uiRecord record -W true -c true "$@"
' maestro-touch "$dir/${token}.stop" "$@" | while IFS= read -r line; do
    case "$line" in
      'Layout saved to :'*)
        source=\${line#Layout saved to :}
        source=\${source# }
        name=\${source##*/}
        if test "$source" = "/data/local/tmp/$name" && printf '%s\\n' "$name" | grep -Exq '${layoutPattern}' &&
           ! printf '%s\\n' "$existing" | grep -Fxq "$source" &&
           test -f "$source" && test ! -L "$source" && test ! -e "$dir/$name" && test ! -L "$dir/$name"; then
          mv -T "$source" "$dir/$name" || printf 'MAESTRO_LAYOUT_UNCLAIMED %s\\n' "$name"
        fi
        ;;
    esac
    printf '%s\\n' "$line"
  done
) 9<"$dir"
`;
}

export class TouchRecording {
  private readonly token = randomUUID();
  private readonly args: string[];
  private stopping?: Promise<void>;
  readonly result: Promise<{ events: string; layouts?: TouchLayouts; released: boolean; started: boolean; busy: boolean; detail?: string }>;

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
        if (line.startsWith('MAESTRO_LAYOUT_UNCLAIMED ')) {
          onProblem(new Error('系统保存的控件树未能归入本轮目录。对应触摸将使用坐标。'));
          return;
        }
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
          result => resolve({ events: result.events.toString('utf8'), layouts: result.layouts, released: true, started, busy, detail }),
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
