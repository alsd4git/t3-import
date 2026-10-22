import { describe, expect, it } from 'vitest';
// @ts-expect-error Release helpers are plain Node.js JavaScript used by the workflow.
import { packedArtifact, releaseNotes, supportsTrustedPublishing, validateRelease } from '../scripts/release.mjs';

describe('release helpers', () => {
  const packageJson = { name: '@alsdd/t3-import', version: '0.1.2-alsd.1' };
  const lockJson = { version: packageJson.version, packages: { '': { version: packageJson.version } } };

  it('requires the exact package tag, package identity, repository and lock versions', () => {
    expect(() => validateRelease({ tag: 'v0.1.2-alsd.1', packageJson, lockJson, repository: 'alsd4git/t3-import' })).not.toThrow();
    expect(() => validateRelease({ tag: 'v0.1.2', packageJson, lockJson, repository: 'alsd4git/t3-import' })).toThrow(/exactly match/);
    expect(() => validateRelease({ tag: 'v0.1.2-alsd.1', packageJson: { ...packageJson, name: 'elsewhere' }, lockJson, repository: 'alsd4git/t3-import' })).toThrow(/package name/);
    expect(() => validateRelease({ tag: 'v0.1.2-alsd.1', packageJson, lockJson: { ...lockJson, version: '0.1.1' }, repository: 'alsd4git/t3-import' })).toThrow(/package-lock/);
    expect(() => validateRelease({ tag: 'v0.1.2-alsd.1', packageJson, lockJson, repository: 'someone/t3-import' })).toThrow(/repository/);
  });

  it('extracts just the matching changelog section', () => {
    const changelog = '# Changelog\n\n## 0.1.2-alsd.1\n\n- New feature\n\n## 0.1.1-alsd.1\n\n- Older feature\n';
    expect(releaseNotes(changelog, '0.1.2-alsd.1')).toBe('- New feature');
    expect(() => releaseNotes(changelog, '0.1.0')).toThrow(/no section/);
  });

  it('accepts npm 11 arrays and npm 12 keyed pack output, while rejecting unexpected artifacts', () => {
    const artifact = { name: packageJson.name, filename: 'alsdd-t3-import-0.1.2-alsd.1.tgz' };
    expect(packedArtifact([artifact], packageJson.name)).toEqual(artifact);
    expect(packedArtifact({ [packageJson.name]: artifact }, packageJson.name)).toEqual(artifact);
    expect(() => packedArtifact([], packageJson.name)).toThrow();
    expect(() => packedArtifact([artifact, artifact], packageJson.name)).toThrow();
    expect(() => packedArtifact([{ ...artifact, name: 'unexpected' }], packageJson.name)).toThrow();
    expect(() => packedArtifact([{ ...artifact, filename: '../other.tgz' }], packageJson.name)).toThrow();
  });

  it('requires npm 11.5.1 or newer for trusted publishing', () => {
    expect(supportsTrustedPublishing('npm/11.5.0 node/v22.0.0')).toBe(false);
    expect(supportsTrustedPublishing('npm/11.5.1 node/v22.0.0')).toBe(true);
    expect(supportsTrustedPublishing('npm/12.2.0 node/v24.0.0')).toBe(true);
  });
});
