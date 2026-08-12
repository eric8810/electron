#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, join, resolve as resolvePath } from 'node:path';

const ELECTRON_VERSION = '41.7.1';
const BASE_SOURCE_COMMIT = 'fda774933622cbc110f34a43015cc1fe6f4f56b3';
const PATCH_TIP_COMMIT = '048b3cf5dcf4a5e7f27497f3d6b92224fddf184a';
const REPOSITORY = 'eric8810/electron';
const REGRESSION_SPEC = 'retargets a wheel gesture after an unconsumed direction change';
const NATIVE_PATCH_PATHS = [
  'shell/browser/osr/osr_render_widget_host_view.cc',
  'shell/browser/osr/osr_render_widget_host_view.h',
  'spec/api-browser-window-spec.ts'
];
const ALLOWED_SOURCE_CHANGES = new Set([
  '.github/workflows/dimcode-osr-wheel.yml',
  '.github/workflows/dimcode-prebuilt-release.yml',
  '.github/workflows/dimcode-prebuilt-target.yml',
  'script/dimcode/assert-windows-toolchain.ps1',
  'script/dimcode/prebuilt-release.mjs',
  'script/dimcode/prebuilt-release.spec.mjs',
  ...NATIVE_PATCH_PATHS
]);
const SUPPORTED_TARGETS = new Map([
  ['darwin-arm64', { manifestPlatform: 'mac' }],
  ['darwin-x64', { manifestPlatform: 'mac' }],
  ['linux-x64', { manifestPlatform: 'linux' }],
  ['win32-x64', { manifestPlatform: 'win' }]
]);

const fail = (message) => {
  throw new Error(`[dimcode-prebuilt] ${message}`);
};

const requireString = (value, name, pattern) => {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${name} is required`);
  }
  if (pattern && !pattern.test(value)) {
    fail(`${name} is invalid: ${value}`);
  }
  return value;
};

const assertExactKeys = (value, expectedKeys, name) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${name} keys mismatch: expected ${expected.join(', ')}, got ${actual.join(', ')}`);
  }
};

const parseOptions = (args) => {
  const command = args.shift();
  if (!['prepare', 'aggregate', 'verify'].includes(command)) {
    fail('usage: prebuilt-release.mjs <prepare|aggregate|verify> --input value');
  }
  const options = new Map();
  while (args.length > 0) {
    const key = args.shift();
    const value = args.shift();
    if (!key?.startsWith('--') || value === undefined) {
      fail(`invalid argument near ${key ?? '<end>'}`);
    }
    if (options.has(key)) {
      fail(`duplicate option: ${key}`);
    }
    options.set(key, value);
  }
  return { command, options };
};

const getOption = (options, name) => requireString(options.get(`--${name}`), `--${name}`);

const sha256 = (filePath) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });

const ensureEmptyDirectory = (directory) => {
  mkdirSync(directory, { recursive: true });
  const entries = readdirSync(directory);
  if (entries.length !== 0) {
    fail(`output directory must be empty: ${directory}`);
  }
};

const listFiles = (directory) => {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
};

const readJson = (filePath) => {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`cannot parse ${filePath}: ${error.message}`);
  }
};

const writeJson = (filePath, value) => {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const requireCiIdentity = () => {
  const repository = requireString(process.env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY');
  if (repository !== REPOSITORY) {
    fail(`repository must be ${REPOSITORY}, got ${repository}`);
  }
  const runId = requireString(process.env.GITHUB_RUN_ID, 'GITHUB_RUN_ID', /^\d+$/);
  const runAttempt = requireString(process.env.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT', /^\d+$/);
  const sourceCommit = requireString(process.env.GITHUB_SHA, 'GITHUB_SHA', /^[0-9a-f]{40,64}$/);
  const refType = requireString(process.env.GITHUB_REF_TYPE, 'GITHUB_REF_TYPE');
  const refName = requireString(process.env.GITHUB_REF_NAME, 'GITHUB_REF_NAME');

  let releaseTag = null;
  let customRevision;
  if (refType === 'tag') {
    const match = /^dimcode-v41\.7\.1-(r[1-9]\d*)$/.exec(refName);
    if (!match) {
      fail(`release tag is invalid: ${refName}`);
    }
    releaseTag = refName;
    customRevision = match[1];
  } else if (refType === 'branch') {
    customRevision = `ci.${runId}.${runAttempt}`;
  } else {
    fail(`unsupported GITHUB_REF_TYPE: ${refType}`);
  }

  return {
    repository,
    runId,
    runAttempt,
    runUrl: `https://github.com/${repository}/actions/runs/${runId}`,
    sourceCommit,
    releaseTag,
    customRevision
  };
};

const validateSourcePatch = (actualHead) => {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', BASE_SOURCE_COMMIT, actualHead]);
    execFileSync('git', ['merge-base', '--is-ancestor', PATCH_TIP_COMMIT, actualHead]);
  } catch {
    fail(`required source history is not an ancestor of ${actualHead}`);
  }
  const nativeDrift = execFileSync('git', [
    'diff',
    '--name-only',
    '-z',
    `${PATCH_TIP_COMMIT}..${actualHead}`,
    '--',
    ...NATIVE_PATCH_PATHS
  ]);
  if (nativeDrift.length !== 0) {
    fail('native wheel patch differs from the reviewed patch tip');
  }
  const changedPaths = execFileSync('git', ['diff', '--name-only', '-z', `${BASE_SOURCE_COMMIT}..${actualHead}`])
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const unexpectedPaths = changedPaths.filter((path) => !ALLOWED_SOURCE_CHANGES.has(path));
  if (unexpectedPaths.length !== 0) {
    fail(`source contains changes outside the release allowlist: ${unexpectedPaths.join(', ')}`);
  }
  const missingRequiredPaths = [...ALLOWED_SOURCE_CHANGES].filter((path) => !changedPaths.includes(path));
  if (missingRequiredPaths.length !== 0) {
    fail(`source is missing required release paths: ${missingRequiredPaths.join(', ')}`);
  }
};

const validatePlatformManifest = (manifest, name) => {
  assertExactKeys(
    manifest,
    [
      'schemaVersion',
      'kind',
      'releaseTag',
      'customRevision',
      'electronVersion',
      'baseSourceCommit',
      'patchedSourceCommit',
      'platform',
      'architecture',
      'asset',
      'gnArgs',
      'distManifest',
      'regressionSpec',
      'workflow',
      'builtAt'
    ],
    name
  );
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'dimcode-electron-prebuilt-platform') {
    fail(`${name} schema identity is invalid`);
  }
  if (manifest.electronVersion !== ELECTRON_VERSION) {
    fail(`${name} Electron version is invalid`);
  }
  if (manifest.baseSourceCommit !== BASE_SOURCE_COMMIT) {
    fail(`${name} base source commit is invalid`);
  }
  const target = `${manifest.platform}-${manifest.architecture}`;
  const supported = SUPPORTED_TARGETS.get(target);
  if (!supported) {
    fail(`${name} target is unsupported: ${target}`);
  }
  assertExactKeys(manifest.asset, ['filename', 'sha256', 'bytes'], `${name}.asset`);
  requireString(manifest.asset.filename, `${name}.asset.filename`, /^electron-v.+\.zip$/);
  requireString(manifest.asset.sha256, `${name}.asset.sha256`, /^[0-9a-f]{64}$/);
  if (!Number.isSafeInteger(manifest.asset.bytes) || manifest.asset.bytes <= 0) {
    fail(`${name}.asset.bytes must be a positive safe integer`);
  }
  if (!Array.isArray(manifest.gnArgs) || manifest.gnArgs.length === 0) {
    fail(`${name}.gnArgs must be a non-empty array`);
  }
  if (manifest.distManifest !== `dist_zip.${supported.manifestPlatform}.${manifest.architecture}.manifest`) {
    fail(`${name}.distManifest is invalid`);
  }
  if (manifest.regressionSpec !== REGRESSION_SPEC) {
    fail(`${name}.regressionSpec is invalid`);
  }
  assertExactKeys(manifest.workflow, ['repository', 'runId', 'runAttempt', 'runUrl'], `${name}.workflow`);
  if (manifest.workflow.repository !== REPOSITORY) {
    fail(`${name}.workflow.repository is invalid`);
  }
  requireString(manifest.patchedSourceCommit, `${name}.patchedSourceCommit`, /^[0-9a-f]{40,64}$/);
  requireString(manifest.customRevision, `${name}.customRevision`, /^(r[1-9]\d*|ci\.\d+\.\d+)$/);
  if (manifest.releaseTag !== null) {
    requireString(manifest.releaseTag, `${name}.releaseTag`, /^dimcode-v41\.7\.1-r[1-9]\d*$/);
    if (manifest.releaseTag !== `dimcode-v${ELECTRON_VERSION}-${manifest.customRevision}`) {
      fail(`${name}.releaseTag does not match customRevision`);
    }
  } else if (!manifest.customRevision.startsWith('ci.')) {
    fail(`${name}.customRevision must be a CI revision when releaseTag is null`);
  }
  const expectedFilename = `electron-v${ELECTRON_VERSION}-dimcode.${manifest.customRevision}-${manifest.platform}-${manifest.architecture}.zip`;
  if (manifest.asset.filename !== expectedFilename) {
    fail(`${name}.asset.filename is invalid`);
  }
  const normalizedArgs = manifest.gnArgs.join('\n').replaceAll(' ', '');
  const requiredArgs = [
    'import("//electron/build/args/release.gn")',
    `target_cpu="${manifest.architecture}"`,
    `override_electron_version="${ELECTRON_VERSION}"`
  ];
  if (requiredArgs.some((arg) => !normalizedArgs.includes(arg.replaceAll(' ', '')))) {
    fail(`${name}.gnArgs does not describe the required release build`);
  }
  requireString(manifest.workflow.runId, `${name}.workflow.runId`, /^\d+$/);
  requireString(manifest.workflow.runAttempt, `${name}.workflow.runAttempt`, /^\d+$/);
  if (manifest.workflow.runUrl !== `https://github.com/${REPOSITORY}/actions/runs/${manifest.workflow.runId}`) {
    fail(`${name}.workflow.runUrl is invalid`);
  }
  requireString(manifest.builtAt, `${name}.builtAt`);
  if (Number.isNaN(Date.parse(manifest.builtAt))) {
    fail(`${name}.builtAt is invalid`);
  }
  return manifest;
};

const prepare = async (options) => {
  const buildDirectory = resolvePath(getOption(options, 'build-dir'));
  const outputDirectory = resolvePath(getOption(options, 'output-dir'));
  const platform = getOption(options, 'platform');
  const architecture = getOption(options, 'arch');
  const target = `${platform}-${architecture}`;
  const supported = SUPPORTED_TARGETS.get(target);
  if (!supported) {
    fail(`unsupported target: ${target}`);
  }
  const identity = requireCiIdentity();
  const actualHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (actualHead !== identity.sourceCommit) {
    fail(`checkout HEAD ${actualHead} does not match GITHUB_SHA ${identity.sourceCommit}`);
  }
  validateSourcePatch(actualHead);

  const argsPath = join(buildDirectory, 'args.gn');
  const distPath = join(buildDirectory, 'dist.zip');
  if (!existsSync(argsPath) || !existsSync(distPath)) {
    fail(`release args.gn and dist.zip are required in ${buildDirectory}`);
  }
  const argsContent = readFileSync(argsPath, 'utf8');
  const requiredArgs = [
    'import("//electron/build/args/release.gn")',
    `target_cpu="${architecture}"`,
    `override_electron_version="${ELECTRON_VERSION}"`
  ];
  for (const requiredArg of requiredArgs) {
    if (!argsContent.replaceAll(' ', '').includes(requiredArg.replaceAll(' ', ''))) {
      fail(`release args.gn is missing ${requiredArg}`);
    }
  }

  ensureEmptyDirectory(outputDirectory);
  const assetFilename = `electron-v${ELECTRON_VERSION}-dimcode.${identity.customRevision}-${platform}-${architecture}.zip`;
  const assetPath = join(outputDirectory, assetFilename);
  copyFileSync(distPath, assetPath);
  const assetHash = await sha256(assetPath);
  const assetBytes = statSync(assetPath).size;
  const manifest = {
    schemaVersion: 1,
    kind: 'dimcode-electron-prebuilt-platform',
    releaseTag: identity.releaseTag,
    customRevision: identity.customRevision,
    electronVersion: ELECTRON_VERSION,
    baseSourceCommit: BASE_SOURCE_COMMIT,
    patchedSourceCommit: identity.sourceCommit,
    platform,
    architecture,
    asset: {
      filename: assetFilename,
      sha256: assetHash,
      bytes: assetBytes
    },
    gnArgs: argsContent
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
    distManifest: `dist_zip.${supported.manifestPlatform}.${architecture}.manifest`,
    regressionSpec: REGRESSION_SPEC,
    workflow: {
      repository: identity.repository,
      runId: identity.runId,
      runAttempt: identity.runAttempt,
      runUrl: identity.runUrl
    },
    builtAt: new Date().toISOString()
  };
  validatePlatformManifest(manifest, 'generated platform manifest');
  writeJson(join(outputDirectory, `platform-manifest-${target}.json`), manifest);
  console.log(`[dimcode-prebuilt] prepared ${assetFilename}`);
};

const validateCommonIdentity = (manifests) => {
  const first = manifests[0];
  const commonKeys = ['releaseTag', 'customRevision', 'electronVersion', 'baseSourceCommit', 'patchedSourceCommit'];
  for (const manifest of manifests.slice(1)) {
    for (const key of commonKeys) {
      if (manifest[key] !== first[key]) {
        fail(`platform manifests disagree on ${key}`);
      }
    }
    if (JSON.stringify(manifest.workflow) !== JSON.stringify(first.workflow)) {
      fail('platform manifests disagree on workflow identity');
    }
  }
  return first;
};

const aggregate = async (options) => {
  const inputDirectory = resolvePath(getOption(options, 'input-dir'));
  const outputDirectory = resolvePath(getOption(options, 'output-dir'));
  const manifestPaths = listFiles(inputDirectory).filter((path) => basename(path).startsWith('platform-manifest-'));
  if (manifestPaths.length !== SUPPORTED_TARGETS.size) {
    fail(`expected ${SUPPORTED_TARGETS.size} platform manifests, got ${manifestPaths.length}`);
  }
  const entries = manifestPaths.map((path) => ({
    path,
    manifest: validatePlatformManifest(readJson(path), path)
  }));
  const targetKeys = entries.map(({ manifest }) => `${manifest.platform}-${manifest.architecture}`);
  if (new Set(targetKeys).size !== SUPPORTED_TARGETS.size) {
    fail('platform manifests contain duplicate targets');
  }
  for (const target of SUPPORTED_TARGETS.keys()) {
    if (!targetKeys.includes(target)) {
      fail(`platform manifest is missing target ${target}`);
    }
  }
  const common = validateCommonIdentity(entries.map(({ manifest }) => manifest));
  ensureEmptyDirectory(outputDirectory);

  const artifacts = [];
  for (const { path, manifest } of entries) {
    const sourceAsset = join(resolvePath(path, '..'), manifest.asset.filename);
    if (!existsSync(sourceAsset)) {
      fail(`asset is missing beside platform manifest: ${sourceAsset}`);
    }
    const actualHash = await sha256(sourceAsset);
    const actualBytes = statSync(sourceAsset).size;
    if (actualHash !== manifest.asset.sha256 || actualBytes !== manifest.asset.bytes) {
      fail(`asset integrity mismatch: ${sourceAsset}`);
    }
    copyFileSync(sourceAsset, join(outputDirectory, manifest.asset.filename));
    artifacts.push({
      platform: manifest.platform,
      architecture: manifest.architecture,
      filename: manifest.asset.filename,
      sha256: manifest.asset.sha256,
      bytes: manifest.asset.bytes,
      gnArgs: manifest.gnArgs,
      distManifest: manifest.distManifest,
      regressionSpec: manifest.regressionSpec,
      builtAt: manifest.builtAt
    });
  }
  artifacts.sort((left, right) => left.filename.localeCompare(right.filename));
  const releaseManifest = {
    schemaVersion: 1,
    kind: 'dimcode-electron-prebuilt-release',
    releaseTag: common.releaseTag,
    customRevision: common.customRevision,
    electronVersion: common.electronVersion,
    source: {
      baseCommit: common.baseSourceCommit,
      patchedCommit: common.patchedSourceCommit
    },
    workflow: common.workflow,
    artifacts,
    assembledAt: new Date().toISOString()
  };
  writeJson(join(outputDirectory, 'build-manifest.json'), releaseManifest);
  writeFileSync(
    join(outputDirectory, 'SHASUMS256.txt'),
    `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.filename}`).join('\n')}\n`
  );
  await verifyDirectory(outputDirectory);
  console.log(`[dimcode-prebuilt] aggregated ${artifacts.length} platform assets`);
};

const validateReleaseManifest = (manifest) => {
  assertExactKeys(
    manifest,
    [
      'schemaVersion',
      'kind',
      'releaseTag',
      'customRevision',
      'electronVersion',
      'source',
      'workflow',
      'artifacts',
      'assembledAt'
    ],
    'build-manifest.json'
  );
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'dimcode-electron-prebuilt-release') {
    fail('release manifest schema identity is invalid');
  }
  if (manifest.electronVersion !== ELECTRON_VERSION) {
    fail('release manifest Electron version is invalid');
  }
  assertExactKeys(manifest.source, ['baseCommit', 'patchedCommit'], 'release manifest source');
  if (manifest.source.baseCommit !== BASE_SOURCE_COMMIT) {
    fail('release manifest base commit is invalid');
  }
  requireString(manifest.source.patchedCommit, 'release manifest patched commit', /^[0-9a-f]{40,64}$/);
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== SUPPORTED_TARGETS.size) {
    fail(`release manifest must contain ${SUPPORTED_TARGETS.size} artifacts`);
  }
  requireString(manifest.customRevision, 'release manifest custom revision', /^(r[1-9]\d*|ci\.\d+\.\d+)$/);
  if (manifest.releaseTag !== null) {
    requireString(manifest.releaseTag, 'release manifest tag', /^dimcode-v41\.7\.1-r[1-9]\d*$/);
    if (manifest.releaseTag !== `dimcode-v${ELECTRON_VERSION}-${manifest.customRevision}`) {
      fail('release manifest tag does not match custom revision');
    }
  } else if (!manifest.customRevision.startsWith('ci.')) {
    fail('release manifest custom revision must be a CI revision when release tag is null');
  }
  assertExactKeys(manifest.workflow, ['repository', 'runId', 'runAttempt', 'runUrl'], 'release manifest workflow');
  if (manifest.workflow.repository !== REPOSITORY) {
    fail('release manifest repository is invalid');
  }
  requireString(manifest.workflow.runId, 'release manifest workflow runId', /^\d+$/);
  requireString(manifest.workflow.runAttempt, 'release manifest workflow runAttempt', /^\d+$/);
  if (manifest.workflow.runUrl !== `https://github.com/${REPOSITORY}/actions/runs/${manifest.workflow.runId}`) {
    fail('release manifest workflow URL is invalid');
  }
  requireString(manifest.assembledAt, 'release manifest assembledAt');
  if (Number.isNaN(Date.parse(manifest.assembledAt))) {
    fail('release manifest assembledAt is invalid');
  }
  return manifest;
};

const verifyDirectory = async (directory) => {
  const manifest = validateReleaseManifest(readJson(join(directory, 'build-manifest.json')));
  const expectedTargets = new Set(SUPPORTED_TARGETS.keys());
  const seenTargets = new Set();
  const filenames = new Set();
  for (const artifact of manifest.artifacts) {
    assertExactKeys(
      artifact,
      [
        'platform',
        'architecture',
        'filename',
        'sha256',
        'bytes',
        'gnArgs',
        'distManifest',
        'regressionSpec',
        'builtAt'
      ],
      'release artifact'
    );
    const target = `${artifact.platform}-${artifact.architecture}`;
    if (!expectedTargets.has(target) || seenTargets.has(target)) {
      fail(`release artifact target is invalid or duplicated: ${target}`);
    }
    seenTargets.add(target);
    if (filenames.has(artifact.filename)) {
      fail(`release artifact filename is duplicated: ${artifact.filename}`);
    }
    filenames.add(artifact.filename);
    requireString(artifact.sha256, `${artifact.filename} sha256`, /^[0-9a-f]{64}$/);
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) {
      fail(`${artifact.filename} bytes is invalid`);
    }
    if (!Array.isArray(artifact.gnArgs) || artifact.gnArgs.length === 0) {
      fail(`${artifact.filename} GN args are invalid`);
    }
    if (artifact.regressionSpec !== REGRESSION_SPEC) {
      fail(`${artifact.filename} regression evidence is invalid`);
    }
    const expectedFilename = `electron-v${ELECTRON_VERSION}-dimcode.${manifest.customRevision}-${artifact.platform}-${artifact.architecture}.zip`;
    if (artifact.filename !== expectedFilename) {
      fail(`${artifact.filename} does not match release identity`);
    }
    const supported = SUPPORTED_TARGETS.get(target);
    if (artifact.distManifest !== `dist_zip.${supported.manifestPlatform}.${artifact.architecture}.manifest`) {
      fail(`${artifact.filename} dist manifest is invalid`);
    }
    const normalizedArgs = artifact.gnArgs.join('\n').replaceAll(' ', '');
    if (
      !normalizedArgs.includes('import("//electron/build/args/release.gn")') ||
      !normalizedArgs.includes(`target_cpu="${artifact.architecture}"`) ||
      !normalizedArgs.includes(`override_electron_version="${ELECTRON_VERSION}"`)
    ) {
      fail(`${artifact.filename} GN args are invalid`);
    }
    requireString(artifact.builtAt, `${artifact.filename} builtAt`);
    if (Number.isNaN(Date.parse(artifact.builtAt))) {
      fail(`${artifact.filename} builtAt is invalid`);
    }
    const assetPath = join(directory, artifact.filename);
    if (!existsSync(assetPath)) {
      fail(`release artifact is missing: ${assetPath}`);
    }
    if ((await sha256(assetPath)) !== artifact.sha256 || statSync(assetPath).size !== artifact.bytes) {
      fail(`release artifact integrity mismatch: ${assetPath}`);
    }
  }
  const expectedSums = `${[...manifest.artifacts]
    .sort((left, right) => left.filename.localeCompare(right.filename))
    .map((artifact) => `${artifact.sha256}  ${artifact.filename}`)
    .join('\n')}\n`;
  const sumsPath = join(directory, 'SHASUMS256.txt');
  if (readFileSync(sumsPath, 'utf8') !== expectedSums) {
    fail('SHASUMS256.txt does not match build-manifest.json');
  }
  const expectedFiles = new Set([
    'build-manifest.json',
    'SHASUMS256.txt',
    ...manifest.artifacts.map((artifact) => artifact.filename)
  ]);
  const actualFiles = readdirSync(directory, { withFileTypes: true });
  if (
    actualFiles.some((entry) => !entry.isFile() || !expectedFiles.has(entry.name)) ||
    actualFiles.length !== expectedFiles.size
  ) {
    fail('release bundle contains missing or unexpected files');
  }
  console.log(`[dimcode-prebuilt] verified ${directory}`);
};

const { command, options } = parseOptions(process.argv.slice(2));
if (command === 'prepare') {
  await prepare(options);
} else if (command === 'aggregate') {
  await aggregate(options);
} else {
  await verifyDirectory(resolvePath(getOption(options, 'input-dir')));
}
