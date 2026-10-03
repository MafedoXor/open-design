import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Guards the private-network deployment (deploy/PRIVATE-NETWORK.md): the
// override must publish the port on the private address only, run without
// browser login, and refuse to render without an explicit address. The
// compose checks need the docker CLI; the guide checks always run.

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, '../..');
const deployDir = join(repoRoot, 'deploy');
const guidePath = join(deployDir, 'PRIVATE-NETWORK.md');

const PRIVATE_ADDRESS = '100.64.0.10';
const ORIGIN = `http://${PRIVATE_ADDRESS}:7456`;

function isComposeAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('docker', ['compose', 'version'], { timeout: 5000 }, (err) => resolve(!err));
  });
}

const composeAvailable = await isComposeAvailable();

interface ComposeService {
  ports?: Array<{ host_ip?: string; published?: string; target?: number }>;
  environment?: Record<string, string | null>;
}

async function renderConfig(env: Record<string, string>): Promise<ComposeService> {
  // An empty env file keeps a developer's deploy/.env out of the rendered config.
  const scratch = await mkdtemp(join(tmpdir(), 'od-private-network-'));
  const envFile = join(scratch, 'empty.env');
  await writeFile(envFile, '');
  try {
    const { stdout } = await execFileAsync(
      'docker',
      [
        'compose',
        '--env-file', envFile,
        '-f', join(deployDir, 'docker-compose.yml'),
        '-f', join(deployDir, 'docker-compose.private-network.yml'),
        'config', '--format', 'json',
      ],
      { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env } },
    );
    return JSON.parse(stdout).services['open-design'] as ComposeService;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

test('private-network override publishes the port on the private address only', { skip: !composeAvailable }, async () => {
  const service = await renderConfig({
    OPEN_DESIGN_PRIVATE_ADDRESS: PRIVATE_ADDRESS,
    OPEN_DESIGN_ALLOWED_ORIGINS: ORIGIN,
  });
  assert.equal(service.ports?.length, 1);
  assert.equal(service.ports?.[0]?.host_ip, PRIVATE_ADDRESS);
  assert.equal(service.ports?.[0]?.published, '7456');
  assert.equal(service.ports?.[0]?.target, 7456);
});

test('private-network override turns browser login off and allows the private origin', { skip: !composeAvailable }, async () => {
  const service = await renderConfig({
    OPEN_DESIGN_PRIVATE_ADDRESS: PRIVATE_ADDRESS,
    OPEN_DESIGN_ALLOWED_ORIGINS: ORIGIN,
    // A token left in the environment must not bring the login prompt back.
    OD_API_TOKEN: 'left-over-token',
  });
  assert.equal(service.environment?.OD_DISABLE_API_AUTH, '1');
  assert.equal(service.environment?.OD_API_TOKEN ?? '', '');
  assert.equal(service.environment?.OD_ALLOWED_ORIGINS, ORIGIN);
});

test('private-network override refuses to render without a private address', { skip: !composeAvailable }, async () => {
  await assert.rejects(renderConfig({ OPEN_DESIGN_ALLOWED_ORIGINS: ORIGIN }), /OPEN_DESIGN_PRIVATE_ADDRESS/);
});

test('private-network override refuses to render without allowed origins', { skip: !composeAvailable }, async () => {
  await assert.rejects(renderConfig({ OPEN_DESIGN_PRIVATE_ADDRESS: PRIVATE_ADDRESS }), /OPEN_DESIGN_ALLOWED_ORIGINS/);
});

test('the base compose file still binds to localhost', { skip: !composeAvailable }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'od-private-network-'));
  const envFile = join(scratch, 'empty.env');
  await writeFile(envFile, '');
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['compose', '--env-file', envFile, '-f', join(deployDir, 'docker-compose.yml'), 'config', '--format', 'json'],
      { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } },
    );
    const service = JSON.parse(stdout).services['open-design'] as ComposeService;
    assert.equal(service.ports?.[0]?.host_ip, '127.0.0.1');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('the guide covers worker tokens and the public-exposure warning', async () => {
  const guide = await readFile(guidePath, 'utf8');
  assert.match(guide, /docker-compose\.private-network\.yml/);
  assert.match(guide, /od worker token create --person/);
  assert.match(guide, /od worker token revoke --person/);
  assert.match(guide, /od worker --server/);
  assert.match(guide, /public internet/i);
  assert.match(guide, /only lock/i);
});

test('the guide points at the daemon data directory contract instead of giving data paths', async () => {
  const guide = await readFile(guidePath, 'utf8');
  assert.match(guide, /Daemon data directory contract/);
  assert.doesNotMatch(guide, /OD_DATA_DIR\s*=/);
  assert.doesNotMatch(guide, /\/app\/\.od|\.od\//);
});

test('the deploy README links the private-network guide', async () => {
  const readme = await readFile(join(deployDir, 'README.md'), 'utf8');
  assert.match(readme, /PRIVATE-NETWORK\.md/);
});
