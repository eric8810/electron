import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
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

const runHelper = (args, environment = ciEnvironment, workingDirectory = repository) =>
  spawnSync(process.execPath, [helper, ...args], {
    cwd: workingDirectory,
    env: environment,
    encoding: 'utf8'
  });

const requireSuccess = (result) => {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
};

const createCacheStats = (overrides = {}) => ({
  version: '0.16.0',
  stats: {
    cache_hits: { counts: { 'C/C++': 11659 }, adv_counts: {} },
    cache_misses: { counts: { 'C/C++': 7063 }, adv_counts: {} },
    cache_errors: { counts: {}, adv_counts: {} },
    cache_timeouts: 0,
    cache_read_errors: 0,
    cache_write_errors: 274,
    cache_writes: 6789,
    compile_fails: 0,
    ...overrides
  }
});

test('validates bounded sccache primer and resumed-cache contracts', () => {
  const root = mkdtempSync(join(tmpdir(), 'dimcode-prebuilt-cache-stats-'));
  try {
    const runStats = (name, mode, report) => {
      const inputFile = join(root, `${name}.json`);
      writeFileSync(inputFile, `${JSON.stringify(report)}\n`);
      return runHelper(['cache-stats', '--mode', mode, '--input-file', inputFile]);
    };

    requireSuccess(runStats('linux-observation-primer', 'primer', createCacheStats()));
    requireSuccess(runStats('linux-observation-resumed', 'resumed', createCacheStats()));
    requireSuccess(
      runStats(
        'exact-write-limit',
        'primer',
        createCacheStats({
          cache_hits: { counts: {}, adv_counts: {} },
          cache_misses: { counts: { 'C/C++': 200 }, adv_counts: {} },
          cache_write_errors: 10,
          cache_writes: 190
        })
      )
    );

    const excessiveWrites = runStats(
      'excessive-write-errors',
      'primer',
      createCacheStats({
        cache_hits: { counts: {}, adv_counts: {} },
        cache_misses: { counts: { 'C/C++': 200 }, adv_counts: {} },
        cache_write_errors: 11,
        cache_writes: 189
      })
    );
    assert.notEqual(excessiveWrites.status, 0);
    assert.match(excessiveWrites.stderr, /write failures exceed 5%/);

    const unaccountedMiss = runStats(
      'unaccounted-miss',
      'primer',
      createCacheStats({
        cache_hits: { counts: {}, adv_counts: {} },
        cache_misses: { counts: { 'C/C++': 200 }, adv_counts: {} },
        cache_write_errors: 10,
        cache_writes: 189
      })
    );
    assert.notEqual(unaccountedMiss.status, 0);
    assert.match(unaccountedMiss.stderr, /writes do not account for misses/);

    for (const [name, overrides] of [
      ['cache-error', { cache_errors: { counts: { 'C/C++': 1 }, adv_counts: {} } }],
      ['timeout', { cache_timeouts: 1 }],
      ['read-error', { cache_read_errors: 1 }],
      ['compile-failure', { compile_fails: 1 }]
    ]) {
      const result = runStats(name, 'primer', createCacheStats(overrides));
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, /cache correctness failure/, name);
    }

    const insufficientFreshHits = runStats(
      'insufficient-fresh-hits',
      'resumed',
      createCacheStats({
        cache_hits: { counts: { 'C/C++': 99 }, adv_counts: {} },
        cache_misses: { counts: { 'C/C++': 101 }, adv_counts: {} },
        cache_write_errors: 0,
        cache_writes: 101
      })
    );
    assert.notEqual(insufficientFreshHits.status, 0);
    assert.match(insufficientFreshHits.stderr, /did not resume on a fresh runner/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('settles asynchronous primer cache writes before enforcing exact accounting', () => {
  for (const workflowPath of [
    '.github/workflows/dimcode-prebuilt-release.yml',
    '.github/workflows/dimcode-prebuilt-target.yml'
  ]) {
    const workflow = readFileSync(join(repository, workflowPath), 'utf8');
    const gateStart = workflow.indexOf('      - name: Require populated compiler cache');
    assert.notEqual(gateStart, -1, workflowPath);
    const gateEnd = workflow.indexOf('\n  build:', gateStart);
    assert.notEqual(gateEnd, -1, workflowPath);
    const gate = workflow.slice(gateStart, gateEnd);
    assert.match(gate, /for cache_stats_attempt in 1 2 3 4 5;/, workflowPath);
    assert.match(gate, /cache-stats --mode primer --input-file/, workflowPath);
    assert.match(gate, /if \[\[ "\$\{cache_stats_attempt\}" == 5 \]\]; then\n\s+exit 1/, workflowPath);
    assert.match(gate, /sleep 2/, workflowPath);
  }
});

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

test('requires the exact custom release tag identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'dimcode-prebuilt-release-tag-'));
  try {
    const buildDirectory = join(root, 'build');
    const outputDirectory = join(root, 'output');
    mkdirSync(buildDirectory);
    writeFileSync(join(buildDirectory, 'dist.zip'), 'release fixture\n');
    writeFileSync(
      join(buildDirectory, 'args.gn'),
      [
        'import("//electron/build/args/release.gn")',
        'target_cpu = "x64"',
        'override_electron_version = "41.7.1"',
        ''
      ].join('\n')
    );
    const arguments_ = [
      'prepare',
      '--build-dir',
      buildDirectory,
      '--output-dir',
      outputDirectory,
      '--platform',
      'win32',
      '--arch',
      'x64'
    ];
    const tagEnvironment = {
      ...ciEnvironment,
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REF_NAME: 'dimcode-v41.7.1-r3'
    };
    requireSuccess(runHelper(arguments_, tagEnvironment));
    const manifest = JSON.parse(readFileSync(join(outputDirectory, 'platform-manifest-win32-x64.json'), 'utf8'));
    assert.equal(manifest.releaseTag, 'dimcode-v41.7.1-r3');
    assert.equal(manifest.customRevision, 'r3');
    assert.equal(manifest.asset.filename, 'electron-v41.7.1-dimcode.r3-win32-x64.zip');

    const invalid = runHelper(arguments_, {
      ...tagEnvironment,
      GITHUB_REF_NAME: 'dimcode-v41.7.1-r0'
    });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /release tag is invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects source changes outside the reviewed patch stack', () => {
  const root = mkdtempSync(join(tmpdir(), 'dimcode-prebuilt-source-contract-'));
  try {
    const sourceRepository = join(root, 'electron');
    const buildDirectory = join(root, 'build');
    execFileSync('git', ['clone', '--quiet', '--shared', repository, sourceRepository]);
    execFileSync('git', ['config', 'user.email', 'dimcode-ci@example.invalid'], { cwd: sourceRepository });
    execFileSync('git', ['config', 'user.name', 'DimCode CI'], { cwd: sourceRepository });
    mkdirSync(buildDirectory);
    writeFileSync(join(buildDirectory, 'dist.zip'), 'source contract fixture\n');
    writeFileSync(
      join(buildDirectory, 'args.gn'),
      [
        'import("//electron/build/args/release.gn")',
        'target_cpu = "x64"',
        'override_electron_version = "41.7.1"',
        ''
      ].join('\n')
    );
    const prepareAtHead = (outputName) => {
      const temporaryHead = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: sourceRepository,
        encoding: 'utf8'
      }).trim();
      return runHelper(
        [
          'prepare',
          '--build-dir',
          buildDirectory,
          '--output-dir',
          join(root, outputName),
          '--platform',
          'linux',
          '--arch',
          'x64'
        ],
        { ...ciEnvironment, GITHUB_SHA: temporaryHead },
        sourceRepository
      );
    };

    const unexpectedPath = join(sourceRepository, 'unexpected-source-change.txt');
    writeFileSync(unexpectedPath, 'not part of the reviewed release patch\n');
    execFileSync('git', ['add', 'unexpected-source-change.txt'], { cwd: sourceRepository });
    execFileSync('git', ['commit', '--quiet', '-m', 'test unexpected source change'], { cwd: sourceRepository });
    const unexpected = prepareAtHead('unexpected-output');
    assert.notEqual(unexpected.status, 0);
    assert.match(unexpected.stderr, /source contains changes outside the release allowlist/);

    unlinkSync(unexpectedPath);
    execFileSync('git', ['add', '--all'], { cwd: sourceRepository });
    execFileSync('git', ['commit', '--quiet', '-m', 'test remove unexpected source change'], {
      cwd: sourceRepository
    });
    const nativePath = join(sourceRepository, 'shell/browser/osr/osr_render_widget_host_view.cc');
    appendFileSync(nativePath, '\n// source contract drift fixture\n');
    execFileSync('git', ['add', 'shell/browser/osr/osr_render_widget_host_view.cc'], { cwd: sourceRepository });
    execFileSync('git', ['commit', '--quiet', '-m', 'test native patch drift'], { cwd: sourceRepository });
    const nativeDrift = prepareAtHead('native-drift-output');
    assert.notEqual(nativeDrift.status, 0);
    assert.match(nativeDrift.stderr, /native wheel patch differs from the reviewed patch tip/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
