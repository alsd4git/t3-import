import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = (command, args, options = {}) => {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }).trim();
  } catch (error) {
    const stderr = String(error.stderr ?? '');
    if (stderr) process.stderr.write(stderr);
    error.stderrText = stderr;
    throw error;
  }
};

export function releaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const heading = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (heading < 0) throw new Error(`CHANGELOG.md has no section for ${version}`);
  const end = lines.findIndex((line, index) => index > heading && /^##\s/.test(line));
  const notes = lines.slice(heading + 1, end < 0 ? lines.length : end).join('\n').trim();
  if (!notes) throw new Error(`CHANGELOG.md section for ${version} is empty`);
  return notes;
}

export function validateRelease({ tag, packageJson, lockJson, repository }) {
  if (!/^\d+\.\d+\.\d+-alsd\.\d+$/.test(packageJson.version)) throw new Error('Release version must follow <T3 version>-alsd.<revision>');
  if (tag !== `v${packageJson.version}`) throw new Error(`Tag ${tag} must exactly match v${packageJson.version}`);
  if (packageJson.name !== '@alsdd/t3-import') throw new Error(`Unexpected package name: ${packageJson.name}`);
  if (repository !== 'alsd4git/t3-import') throw new Error(`Unexpected GitHub repository: ${repository}`);
  if (lockJson.version !== packageJson.version || lockJson.packages?.['']?.version !== packageJson.version) {
    throw new Error('package-lock.json version does not match package.json');
  }
}

export function packedArtifact(output, name) {
  const values = Array.isArray(output) ? output : Object.values(output);
  const packed = values[0];
  if (values.length !== 1 || packed?.name !== name || typeof packed.filename !== 'string' || basename(packed.filename) !== packed.filename) {
    throw new Error('npm pack did not produce exactly one matching tarball');
  }
  return packed;
}

export function supportsTrustedPublishing(userAgent) {
  const match = userAgent.match(/(?:^|\s)npm\/(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1)));
}

async function npm(args, options = {}) {
  const npmPath = process.env.npm_execpath;
  if (!npmPath) throw new Error('npm_execpath is required; run this through an npm script');
  return run(process.execPath, [npmPath, ...args], options);
}

async function prepare() {
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lockJson = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
  const tag = process.env.GITHUB_REF_NAME;
  validateRelease({ tag, packageJson, lockJson, repository: process.env.GITHUB_REPOSITORY });
  run('git', ['fetch', 'origin', 'main:refs/remotes/origin/main', '--no-tags']);
  run('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']);

  const out = join(root, 'artifacts', 'release');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const packed = packedArtifact(JSON.parse(await npm(['pack', '--json', '--pack-destination', out])), packageJson.name);
  const tarballName = packed.filename;
  const tarballPath = join(out, tarballName);
  const tarball = await readFile(tarballPath);
  const sha256 = createHash('sha256').update(tarball).digest('hex');
  await writeFile(join(out, 'SHA256SUMS'), `${sha256}  ${tarballName}\n`);
  await writeFile(join(out, 'RELEASE_NOTES.md'), `${releaseNotes(changelog, packageJson.version)}\n`);
  await writeFile(join(out, 'release-manifest.json'), JSON.stringify({ tag, name: packageJson.name, version: packageJson.version, tarball: tarballName, sha256 }, null, 2) + '\n');
}

async function publish() {
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lockJson = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const tag = process.env.GITHUB_REF_NAME;
  validateRelease({ tag, packageJson, lockJson, repository: process.env.GITHUB_REPOSITORY });
  const out = join(root, 'artifacts', 'release');
  const manifest = JSON.parse(await readFile(join(out, 'release-manifest.json'), 'utf8'));
  if (manifest.tag !== tag || manifest.name !== packageJson.name || manifest.version !== packageJson.version) throw new Error('Release artifact manifest does not match this tag and package');
  const tarballPath = join(out, manifest.tarball);
  const tarball = await readFile(tarballPath);
  if (createHash('sha256').update(tarball).digest('hex') !== manifest.sha256) throw new Error('Release tarball SHA-256 does not match manifest');

  let existing;
  try {
    existing = JSON.parse(await npm(['view', `${packageJson.name}@${packageJson.version}`, 'dist.integrity', '--json']));
  } catch (error) {
    if (!String(error.stderrText ?? error.message).includes('E404')) throw error;
  }
  if (existing) {
    const expected = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
    if (existing !== expected) throw new Error('Published npm version has different dist.integrity; refusing to continue');
    console.log(`npm ${packageJson.name}@${packageJson.version} already matches this tarball`);
    return;
  }
  await npm(['publish', tarballPath, '--access', 'public', '--tag', 'latest', '--provenance']);
  console.log(`Published ${packageJson.name}@${packageJson.version} from ${manifest.tarball}`);
}

async function githubRelease() {
  const out = join(root, 'artifacts', 'release');
  const manifest = JSON.parse(await readFile(join(out, 'release-manifest.json'), 'utf8'));
  const tag = process.env.GITHUB_REF_NAME;
  const files = [manifest.tarball, 'SHA256SUMS'];
  const scratch = await mkdtemp(join(tmpdir(), 't3-release-'));
  try {
    let release;
    try {
      release = JSON.parse(run('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY}/releases/tags/${tag}`]));
    } catch (error) {
      if (!String(error.stderrText ?? error.message).includes('404')) throw error;
    }
    if (!release) {
      run('gh', ['release', 'create', tag, '--verify-tag', '--prerelease', '--title', `t3-import ${manifest.version}`, '--notes-file', join(out, 'RELEASE_NOTES.md')]);
      release = JSON.parse(run('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY}/releases/tags/${tag}`]));
    }
    if (!release.prerelease || release.draft) throw new Error(`GitHub release ${tag} must be a published prerelease`);
    for (const name of files) {
      const expected = await readFile(join(out, name));
      const asset = release.assets.find((item) => item.name === name);
      if (asset) {
        const dest = join(scratch, basename(name));
        run('gh', ['release', 'download', tag, '--pattern', name, '--dir', scratch]);
        const actual = await readFile(dest);
        if (!actual.equals(expected)) throw new Error(`Existing GitHub release asset ${name} differs; refusing to overwrite`);
      } else {
        run('gh', ['release', 'upload', tag, join(out, name)]);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  if (action === 'check-npm') {
    const userAgent = process.env.npm_config_user_agent ?? '';
    if (!supportsTrustedPublishing(userAgent)) throw new Error(`Trusted publishing requires npm >=11.5.1; found ${userAgent || 'unknown'}`);
    console.log(`Trusted publishing enabled with ${userAgent.match(/npm\/\S+/)?.[0] ?? userAgent}`);
  } else if (action === 'prepare') await prepare();
  else if (action === 'publish') await publish();
  else if (action === 'github-release') await githubRelease();
  else throw new Error('Usage: node scripts/release.mjs <prepare|publish|github-release>');
}
