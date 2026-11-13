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
  if (process.platform === 'darwin') {
    const outDir = path.join(rootDir, '.toolchain', 'bin');
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
