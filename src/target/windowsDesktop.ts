import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { win32 } from "node:path";
import { safetyError } from "../core/errors.js";
import type { TargetPaths } from "../core/types.js";

const execute = promisify(execFile);
export type PowerShellRunner = (script: string) => Promise<string>;
export interface WindowsDesktop {
  pid: number;
  started: string;
  executable: string;
  sha256: string;
  sessionId: number;
  ownerSid: string;
  runtimePid: number;
  runtimeStarted: string;
}
// Restart Manager is queried only for ownership; it is never asked to stop apps.
const ownership = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
public static class T3FileOwners {
 [StructLayout(LayoutKind.Sequential)] public struct Unique { public uint pid; public System.Runtime.InteropServices.ComTypes.FILETIME started; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Info {
  public Unique process;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string name;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string service;
  public uint type, status, session;
  [MarshalAs(UnmanagedType.Bool)] public bool restartable;
 }
 [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint h, uint flags, StringBuilder key);
 [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint files, string[] names, uint apps, Unique[] processes, uint services, string[] serviceNames);
 [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint needed, ref uint count, [In,Out] Info[] apps, ref uint reasons);
 [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
 static void Check(int code) { if(code!=0) throw new System.ComponentModel.Win32Exception(code); }
 public static uint[] Get(string path) {
  uint h; Check(RmStartSession(out h,0,new StringBuilder(33)));
  try {
   Check(RmRegisterResources(h,1,new[]{path},0,null,0,null));
   uint needed=0,count=0,reasons=0; int code=RmGetList(h,out needed,ref count,null,ref reasons);
   if(code==0) return new uint[0];
   if(code!=234) Check(code);
   // Bound retries if process ownership changes while querying.
   for(int attempt=0;attempt<3;attempt++) {
    count=needed; var apps=new Info[count]; code=RmGetList(h,out needed,ref count,apps,ref reasons);
    if(code==234) continue; Check(code);
    var result=new uint[count]; for(int i=0;i<count;i++) result[i]=apps[i].process.pid;
    return result;
   }
   throw new Exception("File ownership changed during inspection");
  } finally { RmEndSession(h); }
 }
}
'@
`;
const helpers = String.raw`
function ProcessInfo([int]$Id) {
 $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$Id)
 if($null -eq $p){throw 'Process no longer exists'}
 return $p
}
function SameProcess($p,$started) { return $p.CreationDate.ToUniversalTime().ToString('o') -eq $started }
function OwnerSid($p) { $v=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid; if($v.ReturnValue -ne 0){throw 'Cannot verify process owner'}; return $v.Sid }
function AssertSession($p,$sid,$session) {
 $self=Get-Process -Id $PID
 if($p.SessionId -le 0 -or $p.SessionId -ne $self.SessionId -or $p.SessionId -ne $session -or (OwnerSid $p) -ne $sid -or $sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value){throw 'Run t3-import in the same Windows desktop session and user as T3; SSH and other sessions cannot restore its window safely'}
}
`;
export async function powershell(script: string): Promise<string> {
  const { stdout } = await execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); $OutputEncoding=[Console]::OutputEncoding; ${script}`, "utf16le").toString("base64")], { timeout: 20_000, maxBuffer: 128 * 1024, windowsHide: true });
  return stdout.trim();
}
function payload(value: unknown): string {
  // Input is data inside an encoded JSON document, never PowerShell source.
  return `$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JSON.stringify(value)).toString("base64")}'))|ConvertFrom-Json;`;
}
export async function windowsFileOwners(databasePath: string, run: PowerShellRunner = powershell): Promise<number[]> {
  const owners: unknown = JSON.parse(await run(payload({ db: databasePath }) + ownership + "ConvertTo-Json -InputObject @([T3FileOwners]::Get($v.db)) -Compress"));
  if (!Array.isArray(owners) || !owners.every((pid) => Number.isSafeInteger(pid) && pid > 0)) throw safetyError("Invalid Windows file ownership report.");
  return owners;
}
export async function discoverWindowsDesktop(paths: TargetPaths, runtimePid: number, run: PowerShellRunner = powershell): Promise<WindowsDesktop> {
  // Refuse unsupported locations before starting PowerShell or compiling native probes.
  const normalized = (path: string) => win32.resolve(path).toLowerCase();
  const home = normalized(win32.join(homedir(), ".t3"));
  const state = win32.join(home, "userdata");
  if (normalized(paths.t3Home) !== home || normalized(paths.stateDir) !== state) throw safetyError("Custom T3 homes require manual maintenance.");
  const database = normalized(paths.dbPath);
  if (win32.dirname(database) !== state || !["statev2.sqlite", "state.sqlite"].includes(win32.basename(database))) throw safetyError("Custom database paths require manual maintenance.");
  if (!(await windowsFileOwners(paths.dbPath, run)).includes(runtimePid)) throw safetyError("The recorded runtime does not own the selected database.");
  const result = JSON.parse(await run(payload({ db: paths.dbPath, home: paths.t3Home, stateDir: paths.stateDir, runtimePid }) + helpers + String.raw`
 $runtime=ProcessInfo $v.runtimePid; $p=$runtime; $visited=@{}
 while($null -ne $p -and -not $visited.ContainsKey([int]$p.ProcessId)) {
  $visited[[int]$p.ProcessId]=$true
  if([IO.Path]::GetFileName($p.ExecutablePath) -match '^T3 Code(?: \([A-Za-z]+\))?\.exe$' -and (Get-Process -Id $p.ProcessId).MainWindowHandle -ne 0){break}
  $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p.ParentProcessId)
 }
 if($null -eq $p -or (Get-Process -Id $p.ProcessId).MainWindowHandle -eq 0){throw 'No owning T3 Desktop window found'}
 $sid=OwnerSid $p; AssertSession $p $sid $p.SessionId
 if((OwnerSid $runtime) -ne $sid -or $runtime.SessionId -ne $p.SessionId){throw 'Runtime and desktop ownership disagree'}
 # Replaying arbitrary argv or a development Electron launcher is unsupported.
 if($p.CommandLine.Trim().Trim('"') -ine $p.ExecutablePath){throw 'Custom T3 launch arguments require manual maintenance'}
 $asar=Join-Path (Split-Path $p.ExecutablePath) 'resources\app.asar'
 if(-not (Test-Path -LiteralPath $asar -PathType Leaf)){throw 'Packaged T3 installation could not be verified'}
 [pscustomobject]@{pid=[int]$p.ProcessId;started=$p.CreationDate.ToUniversalTime().ToString('o');executable=$p.ExecutablePath;sha256=(Get-FileHash -LiteralPath $p.ExecutablePath -Algorithm SHA256).Hash;sessionId=[int]$p.SessionId;ownerSid=$sid;runtimePid=[int]$runtime.ProcessId;runtimeStarted=$runtime.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress
 `)) as WindowsDesktop;
  if (!Number.isSafeInteger(result.pid) || result.pid <= 0 || !Number.isSafeInteger(result.runtimePid) || result.runtimePid !== runtimePid || !result.started || !result.runtimeStarted || !/^[a-f0-9]{64}$/iu.test(result.sha256) || !result.ownerSid || !result.executable || result.sessionId <= 0) throw safetyError("Invalid Windows desktop ownership report.");
  return result;
}
export function sameWindowsDesktop(a: WindowsDesktop | undefined, b: WindowsDesktop): boolean {
  return a !== undefined && ["pid", "started", "executable", "sha256", "sessionId", "ownerSid", "runtimePid", "runtimeStarted"].every((key) => a[key as keyof WindowsDesktop] === b[key as keyof WindowsDesktop]);
}
export async function closeWindowsDesktop(desktop: WindowsDesktop, run: PowerShellRunner = powershell): Promise<void> {
  await run(payload(desktop) + helpers + String.raw`
 $p=ProcessInfo $v.pid; AssertSession $p $v.ownerSid $v.sessionId
 $runtime=ProcessInfo $v.runtimePid
 if(-not (SameProcess $p $v.started) -or -not (SameProcess $runtime $v.runtimeStarted) -or $p.ExecutablePath -ine $v.executable -or (Get-FileHash -LiteralPath $v.executable -Algorithm SHA256).Hash -ine $v.sha256){throw 'Desktop identity changed before close'}
 if(-not (Get-Process -Id $v.pid).CloseMainWindow()){throw 'T3 did not accept the normal window close request'}
 `);
}
export async function windowsDesktopStopped(desktop: WindowsDesktop, run: PowerShellRunner = powershell): Promise<boolean> {
  return await run(payload(desktop) + String.raw`
 $remaining=@(Get-Process -Id $v.pid,$v.runtimePid -ErrorAction SilentlyContinue)
 if($remaining.Count -eq 0){'true'}else{'false'}
 `) === "true";
}
export async function startWindowsDesktop(desktop: WindowsDesktop, run: PowerShellRunner = powershell): Promise<void> {
  await run(payload(desktop) + helpers + String.raw`
 $self=ProcessInfo $PID; AssertSession $self $v.ownerSid $v.sessionId
 if((Get-FileHash -LiteralPath $v.executable -Algorithm SHA256).Hash -ine $v.sha256){throw 'The T3 executable changed during maintenance; reopen it manually'}
 $existing=Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -ieq $v.executable -and $_.SessionId -eq $v.sessionId}
 if(-not $existing){Start-Process -FilePath $v.executable -WorkingDirectory (Split-Path $v.executable)|Out-Null}
 `);
}
export function windowsRecoveryCommand(desktop: WindowsDesktop): string {
  return `Start-Process -FilePath '${desktop.executable.replaceAll("'", "''")}'`;
}
