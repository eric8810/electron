import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const helper = join(repository, 'script/dimcode/prebuilt-release.mjs');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repository,
  encoding: 'utf8'
}).trim();
const ciEnvironment = {
  ...process.env,
  GITHUB_REPOSITORY: 'eric8810/electron',
  GITHUB_RUN_ID: '123456789',
  GITHUB_RUN_ATTEMPT: '2',
  GITHUB_SHA: sourceCommit,
  GITHUB_REF_TYPE: 'branch',
  GITHUB_REF_NAME: 'dimcode/osr-wheel-ci'
};
const targets = [
  { platform: 'darwin', architecture: 'arm64' },
  { platform: 'darwin', architecture: 'x64' },
  { platform: 'linux', architecture: 'x64' },
  { platform: 'win32', architecture: 'x64' }
];

const runHelper = (args) =>
  spawnSync(process.execPath, [helper, ...args], {
    cwd: repository,
    env: ciEnvironment,
    encoding: 'utf8'
  });

const requireSuccess = (result) => {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
};

test('prepares, aggregates, verifies and rejects a tampered prebuilt bundle', () => {
  const root = mkdtempSync(join(tmpdir(), 'dimcode-prebuilt-release-'));
  try {
    const inputDirectory = join(root, 'input');
    const bundleDirectory = join(root, 'bundle');
    mkdirSync(inputDirectory);

    for (const target of targets) {
      const targetName = `${target.platform}-${target.architecture}`;
      const buildDirectory = join(root, `build-${targetName}`);
      const outputDirectory = join(root, `output-${targetName}`);
      mkdirSync(buildDirectory);
      writeFileSync(join(buildDirectory, 'dist.zip'), `fixture:${targetName}\n`);
      writeFileSync(
        join(buildDirectory, 'args.gn'),
        [
          'import("//electron/build/args/release.gn")',
          `target_cpu = "${target.architecture}"`,
          'override_electron_version = "41.7.1"',
          ''
        ].join('\n')
      );
      requireSuccess(
        runHelper([
          'prepare',
          '--build-dir',
          buildDirectory,
          '--output-dir',
          outputDirectory,
          '--platform',
          target.platform,
          '--arch',
          target.architecture
        ])
      );
      cpSync(outputDirectory, join(inputDirectory, `dimcode-electron-${targetName}`), {
        recursive: true
      });
    }

    requireSuccess(runHelper(['aggregate', '--input-dir', inputDirectory, '--output-dir', bundleDirectory]));
    requireSuccess(runHelper(['verify', '--input-dir', bundleDirectory]));

    const manifest = JSON.parse(readFileSync(join(bundleDirectory, 'build-manifest.json'), 'utf8'));
    assert.equal(manifest.releaseTag, null);
    assert.equal(manifest.customRevision, 'ci.123456789.2');
    assert.deepEqual(
      manifest.artifacts.map(({ platform, architecture }) => `${platform}-${architecture}`).sort(),
      targets.map(({ platform, architecture }) => `${platform}-${architecture}`).sort()
    );

    appendFileSync(join(bundleDirectory, manifest.artifacts[0].filename), 'tampered');
    const tampered = runHelper(['verify', '--input-dir', bundleDirectory]);
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /release artifact integrity mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects aggregation when a supported target is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'dimcode-prebuilt-missing-target-'));
  try {
    const result = runHelper(['aggregate', '--input-dir', root, '--output-dir', join(root, 'bundle')]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /expected 4 platform manifests, got 0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
