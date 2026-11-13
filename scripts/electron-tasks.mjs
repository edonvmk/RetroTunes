import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const task = process.argv[2];

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: rootDir,
    stdio: 'inherit',
    ...opts,
  });
  return res.status ?? 1;
}

if (task === 'build-mtp') {
  const outDir = path.join(rootDir, '.toolchain', 'bin');
  if (process.platform === 'darwin') {
    fs.mkdirSync(outDir, { recursive: true });
    run('clang', [
      '-O2',
      '-Wall',
      '-Wno-deprecated-declarations',
      '-framework',
      'IOKit',
      '-framework',
      'CoreFoundation',
      path.join(rootDir, 'native', 'rtunes_mtp.c'),
      '-o',
      path.join(outDir, 'rtunes-mtp'),
    ]);
  } else if (process.platform === 'win32') {
    const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
    const wpdSrc = path.join(rootDir, 'native', 'rtunes_wpd.cs');
    if (fs.existsSync(csc) && fs.existsSync(wpdSrc)) {
      fs.mkdirSync(outDir, { recursive: true });
      const apiInterop = path.join(outDir, 'Interop.PortableDeviceApiLib.dll');
      const typesInterop = path.join(outDir, 'Interop.PortableDeviceTypesLib.dll');
      if (!fs.existsSync(apiInterop) || !fs.existsSync(typesInterop)) {
        const psScript = [
          `$sig = '[DllImport("oleaut32.dll", CharSet = CharSet.Unicode)] public static extern int LoadTypeLib(string szFile, [MarshalAs(UnmanagedType.Interface)] out object pptlib);'`,
          `$t = Add-Type -MemberDefinition $sig -Name TlbGen -PassThru`,
          `$conv = New-Object System.Runtime.InteropServices.TypeLibConverter`,
          `$sinkType = Add-Type -TypeDefinition 'public class Sink : System.Runtime.InteropServices.ITypeLibImporterNotifySink { public void ReportEvent(System.Runtime.InteropServices.ImporterEventKind k, int c, string m) {} public System.Reflection.Assembly ResolveRef(object tl) { return null; } }' -PassThru`,
          `$s = New-Object $sinkType`,
          `$tl1 = $null; $t::LoadTypeLib("C:\\Windows\\System32\\PortableDeviceTypes.dll", [ref]$tl1) | Out-Null`,
          `$ab1 = $conv.ConvertTypeLibToAssembly($tl1, '${typesInterop.replace(/'/g, "''")}', 0, $s, $null, $null, "PortableDeviceTypesLib", $null)`,
          `$ab1.Save("Interop.PortableDeviceTypesLib.dll")`,
          `$tl2 = $null; $t::LoadTypeLib("C:\\Windows\\System32\\PortableDeviceApi.dll", [ref]$tl2) | Out-Null`,
          `$ab2 = $conv.ConvertTypeLibToAssembly($tl2, '${apiInterop.replace(/'/g, "''")}', 0, $s, $null, $null, "PortableDeviceApiLib", $null)`,
          `$ab2.Save("Interop.PortableDeviceApiLib.dll")`,
        ].join('; ');
        run('powershell.exe', ['-NoProfile', '-Command', psScript], { cwd: outDir });
      }
      if (fs.existsSync(apiInterop) && fs.existsSync(typesInterop)) {
        run(csc, [
          '/nologo',
          '/optimize+',
          `/r:${apiInterop}`,
          `/r:${typesInterop}`,
          `/out:${path.join(outDir, 'rtunes-mtp.exe')}`,
          wpdSrc,
        ]);
      }
    }
  }
  process.exit(0);
}

if (task === 'rebuild-native') {
  const electronPkgPath = path.join(rootDir, 'node_modules', 'electron', 'package.json');
  const sqliteDir = path.join(rootDir, 'node_modules', 'better-sqlite3');
  const prebuildBin = path.join(rootDir, 'node_modules', 'prebuild-install', 'bin.js');

  if (!fs.existsSync(electronPkgPath) || !fs.existsSync(sqliteDir) || !fs.existsSync(prebuildBin)) {
    process.exit(0);
  }

  const electronVersion = JSON.parse(fs.readFileSync(electronPkgPath, 'utf8')).version;
  const status = run(
    process.execPath,
    [prebuildBin, '-r', 'electron', '-t', electronVersion],
    { cwd: sqliteDir }
  );
  process.exit(status);
}

if (task === 'launch') {
  const mode = process.argv[3] || 'prod';
  const env = { ...process.env };
  if (mode === 'dev') {
    env.VITE_DEV_SERVER_URL = 'http://localhost:5173';
  } else {
    env.NODE_ENV = 'production';
  }

  const electronBin =
    process.platform === 'win32'
      ? path.join(rootDir, 'node_modules', 'electron', 'dist', 'electron.exe')
      : path.join(rootDir, 'node_modules', '.bin', 'electron');

  const status = run(electronBin, ['.'], { env });
  process.exit(status);
}

console.error(`Unknown task: ${task}`);
process.exit(1);
