import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { c as tarCreate } from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  workerBridgeRunProjectPath,
  type WorkerRunStartEvent,
  type WorkerTokenCreateResponse,
} from '@open-design/contracts';
import { runWorker } from '../src/workers/worker-client.js';
import { createWorkerRunExecutor, type WorkerRunExecutor } from '../src/workers/worker-runs.js';
import type { RemoteAgentProcess } from '../src/workers/remote-runs.js';
import { startWorkerTestServer, waitForWorkerOnline, type WorkerTestServer } from './helpers/worker-server.js';

/**
 * A worker run works on a copy of the project on the person's PC: the worker
 * downloads it before the agent starts, the agent runs in it with the env it
 * needs to call back into the server, and what the agent created, changed or
 * deleted lands in the server's project before the run ends. The "agent" is a
 * node one-liner, so nothing depends on an installed CLI.
 */

let server: WorkerTestServer;
let scratch: string;
let projectDir: string;
let workRoot: string;
const controllers: AbortController[] = [];
const executors: WorkerRunExecutor[] = [];

beforeEach(async () => {
  server = await startWorkerTestServer();
  scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'od-worker-roundtrip-')));
  projectDir = path.join(scratch, 'server', 'projects', 'p1');
  workRoot = path.join(scratch, 'pc');
  mkdirSync(path.join(projectDir, '.od-skills', 'poster'), { recursive: true });
  mkdirSync(path.join(projectDir, '.file-versions'), { recursive: true });
  writeFileSync(path.join(projectDir, 'index.html'), '<h1>before</h1>');
  writeFileSync(path.join(projectDir, 'old.css'), 'body {}');
  writeFileSync(path.join(projectDir, 'keep.txt'), 'keep');
  writeFileSync(path.join(projectDir, '.od-skills', 'poster', 'SKILL.md'), '# poster');
  writeFileSync(path.join(projectDir, '.file-versions', 'index.html.1'), 'history');
});

afterEach(async () => {
  for (const executor of executors.splice(0)) executor.stopAll();
  for (const controller of controllers.splice(0)) controller.abort();
  await server.close();
  rmSync(scratch, { recursive: true, force: true });
});

async function issueToken(person: string): Promise<string> {
  const response = await fetch(`${server.baseUrl}/api/workers/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ person }),
  });
  return ((await response.json()) as WorkerTokenCreateResponse).token;
}

async function connectWorker(person: string): Promise<{ token: string; executor: WorkerRunExecutor }> {
  const token = await issueToken(person);
  const executor = createWorkerRunExecutor({
    serverUrl: server.baseUrl,
    token,
    workRoot,
    cliEnv: { OD_BIN: '/pc/od/cli.js', OD_NODE_BIN: process.execPath },
    env: { ...process.env, PC_ONLY: 'from-the-pc' },
    resolveLaunch: (_agentId, args) => ({ command: process.execPath, args }),
  });
  executors.push(executor);
  const controller = new AbortController();
  controllers.push(controller);
  void runWorker({
    serverUrl: server.baseUrl,
    token,
    describe: async () => ({ hostname: `${person}-pc`, platform: process.platform, agents: [] }),
    signal: controller.signal,
    reconnectDelayMs: () => 10,
    onServerEvent: executor.handle,
  });
  await waitForWorkerOnline(server, person);
  return { token, executor };
}

function collect(child: RemoteAgentProcess) {
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const closed = new Promise<number | null>((resolve) => child.on('close', (code: number | null) => resolve(code)));
  return { closed, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

/** Reports what it found, then edits the project the way an agent would. */
const EDITING_AGENT = `
const fs = require('fs');
const path = require('path');
const list = (dir, prefix = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? list(path.join(dir, entry.name), prefix + entry.name + '/') : [prefix + entry.name]);
const report = {
  cwd: process.cwd(),
  files: list('.').sort(),
  arg: process.argv[1],
  env: {
    OD_TOOL_TOKEN: process.env.OD_TOOL_TOKEN ?? null,
    OD_DAEMON_URL: process.env.OD_DAEMON_URL ?? null,
    OD_PROJECT_ID: process.env.OD_PROJECT_ID ?? null,
    OD_PROJECT_DIR: process.env.OD_PROJECT_DIR ?? null,
    OD_BIN: process.env.OD_BIN ?? null,
    PC_ONLY: process.env.PC_ONLY ?? null,
    SERVER_SECRET: process.env.SERVER_SECRET ?? null,
  },
};
fs.writeFileSync('index.html', '<h1>after</h1>');
fs.writeFileSync('new.html', '<h1>new</h1>');
fs.rmSync('old.css');
fs.mkdirSync('assets/deep', { recursive: true });
fs.writeFileSync('assets/deep/logo.svg', '<svg/>');
console.log(JSON.stringify(report));
process.exitCode = Number(process.argv[2] ?? 0);
`;

function startRun(runId: string, overrides: Partial<WorkerRunStartEvent> = {}): RemoteAgentProcess {
  return server.runs.spawn('Alice', {
    runId,
    agentId: 'claude',
    args: ['-e', EDITING_AGENT, path.join(projectDir, 'notes.txt')],
    stdin: 'ignore',
    project: { id: 'p1', dir: projectDir },
    env: { OD_TOOL_TOKEN: 'tool-123', OD_PROJECT_ID: 'p1', OD_PROJECT_DIR: projectDir },
    ...overrides,
  });
}

interface AgentReport {
  cwd: string;
  files: string[];
  arg: string;
  env: Record<string, string | null>;
}

describe('a worker run with project files', () => {
  it('gives the agent a copy of the project, including staged skills', async () => {
    await connectWorker('Alice');
    const out = collect(startRun('run-copy'));
    expect(await out.closed).toBe(0);
    const report = JSON.parse(out.stdout.trim()) as AgentReport;
    expect(report.files).toEqual(['.od-skills/poster/SKILL.md', 'index.html', 'keep.txt', 'old.css']);
    expect(report.cwd.startsWith(workRoot + path.sep)).toBe(true);
  });

  it('runs the agent with the callback env and its project paths moved to the PC copy', async () => {
    await connectWorker('Alice');
    const out = collect(startRun('run-env', {
      env: {
        OD_TOOL_TOKEN: 'tool-123',
        OD_PROJECT_ID: 'p1',
        OD_PROJECT_DIR: projectDir,
        // A server may not set anything outside the callback allowlist.
        SERVER_SECRET: 'sk-server',
      } as NonNullable<WorkerRunStartEvent['env']>,
    }));
    expect(await out.closed).toBe(0);
    const report = JSON.parse(out.stdout.trim()) as AgentReport;
    expect(report.arg).toBe(path.join(report.cwd, 'notes.txt'));
    expect(report.env).toEqual({
      OD_TOOL_TOKEN: 'tool-123',
      OD_DAEMON_URL: server.baseUrl,
      OD_PROJECT_ID: 'p1',
      OD_PROJECT_DIR: report.cwd,
      OD_BIN: '/pc/od/cli.js',
      PC_ONLY: 'from-the-pc',
      SERVER_SECRET: null,
    });
  });

  it('brings files the agent created, changed and deleted back into the server project before the run ends', async () => {
    await connectWorker('Alice');
    const out = collect(startRun('run-edit'));
    expect(await out.closed).toBe(0);
    expect(readFileSync(path.join(projectDir, 'index.html'), 'utf8')).toBe('<h1>after</h1>');
    expect(readFileSync(path.join(projectDir, 'new.html'), 'utf8')).toBe('<h1>new</h1>');
    expect(readFileSync(path.join(projectDir, 'assets', 'deep', 'logo.svg'), 'utf8')).toBe('<svg/>');
    expect(existsSync(path.join(projectDir, 'old.css'))).toBe(false);
    expect(readFileSync(path.join(projectDir, 'keep.txt'), 'utf8')).toBe('keep');
    expect(readFileSync(path.join(projectDir, '.file-versions', 'index.html.1'), 'utf8')).toBe('history');
  });

  it('removes its copy of the project after the run, also when the agent fails', async () => {
    await connectWorker('Alice');
    const ok = collect(startRun('run-clean-ok'));
    expect(await ok.closed).toBe(0);
    expect(readdirSync(workRoot)).toEqual([]);
    writeFileSync(path.join(projectDir, 'old.css'), 'body {}');
    const failed = collect(startRun('run-clean-fail', {
      args: ['-e', EDITING_AGENT, path.join(projectDir, 'notes.txt'), '3'],
    }));
    expect(await failed.closed).toBe(3);
    expect(readdirSync(workRoot)).toEqual([]);
    // A failed agent's edits are kept, exactly as they would be on the server.
    expect(existsSync(path.join(projectDir, 'old.css'))).toBe(false);
  });

  it('fails the run, without starting the agent, when the project cannot be copied', async () => {
    await connectWorker('Alice');
    const out = collect(startRun('run-no-project', { project: { id: 'gone', dir: path.join(scratch, 'missing') } }));
    expect(await out.closed).not.toBe(0);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('copy the project');
    expect(readdirSync(workRoot)).toEqual([]);
  });

  it('works in the same directory every time for the same project, so the agent can resume its session', async () => {
    await connectWorker('Alice');
    const printCwd = { args: ['-e', 'console.log(process.cwd())'] };
    const first = collect(startRun('run-a', printCwd));
    expect(await first.closed).toBe(0);
    const second = collect(startRun('run-b', printCwd));
    expect(await second.closed).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(first.stdout.startsWith(workRoot + path.sep)).toBe(true);
  });

  it('delivers stdin the server writes while the project is still being copied', async () => {
    await connectWorker('Alice');
    const child = startRun('run-stdin', {
      args: ['-e', "let s='';process.stdin.on('data',(c)=>s+=c);process.stdin.on('end',()=>console.log(s))"],
      stdin: 'pipe',
    });
    const out = collect(child);
    child.stdin!.write('{"type":"user"}\n');
    child.stdin!.end();
    expect(await out.closed).toBe(0);
    expect(out.stdout).toBe('{"type":"user"}\n\n');
  });

  it('moves the server\'s project path in the prompt to the PC copy', async () => {
    await connectWorker('Alice');
    const out = collect(startRun('run-prompt', {
      args: ['-e', "let s='';process.stdin.on('data',(c)=>s+=c);process.stdin.on('end',()=>console.log(JSON.stringify({ s, cwd: process.cwd() })))"],
      stdin: { prompt: `Edit ${path.join(projectDir, 'index.html')} please` },
    }));
    expect(await out.closed).toBe(0);
    const { s, cwd } = JSON.parse(out.stdout.trim()) as { s: string; cwd: string };
    expect(s).toBe(`Edit ${path.join(cwd, 'index.html')} please`);
  });

  it('sends the agent\'s changes back and removes the copy before the worker stops', async () => {
    const { executor } = await connectWorker('Alice');
    const out = collect(startRun('run-shutdown', {
      args: ['-e', "require('fs').writeFileSync('late.html', 'x'); console.log('ready'); setTimeout(() => {}, 30_000)"],
    }));
    await new Promise<void>((resolve) => {
      const check = () => (out.stdout.includes('ready') ? resolve() : setTimeout(check, 20));
      check();
    });
    await executor.stopAll();
    expect(readFileSync(path.join(projectDir, 'late.html'), 'utf8')).toBe('x');
    expect(readdirSync(workRoot)).toEqual([]);
    await out.closed;
  });

  it('starts a run without a project in an empty directory and sends nothing back', async () => {
    await connectWorker('Alice');
    const out = collect(server.runs.spawn('Alice', {
      runId: 'run-bare',
      agentId: 'claude',
      args: ['-e', "console.log(require('fs').readdirSync('.').length); require('fs').writeFileSync('x.txt', 'x')"],
      stdin: 'ignore',
    }));
    expect(await out.closed).toBe(0);
    expect(out.stdout).toBe('0\n');
    expect(existsSync(path.join(projectDir, 'x.txt'))).toBe(false);
    expect(readdirSync(workRoot)).toEqual([]);
  });
});

describe('the project transfer endpoints', () => {
  /** Holds a run open on the server without a worker answering it. */
  async function openRun(runId: string) {
    const { token } = await connectWorker('Alice');
    const child = server.runs.spawn('Alice', {
      runId,
      agentId: 'claude',
      args: ['-e', 'setTimeout(() => {}, 5_000)'],
      stdin: 'ignore',
      project: { id: 'p1', dir: projectDir },
    });
    return { token, child };
  }

  async function changesArchive(build: (staging: string) => string[]): Promise<Buffer> {
    const staging = mkdtempSync(path.join(scratch, 'staging-'));
    const entries = build(staging);
    const chunks: Buffer[] = [];
    for await (const chunk of tarCreate({ gzip: true, cwd: staging, portable: true }, entries)) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  function postChanges(runId: string, token: string, body: Buffer) {
    return fetch(`${server.baseUrl}${workerBridgeRunProjectPath(runId)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/gzip' },
      body,
    });
  }

  it('refuses a deletion outside the project and applies nothing', async () => {
    const { token, child } = await openRun('run-escape');
    writeFileSync(path.join(scratch, 'outside.txt'), 'safe');
    const archive = await changesArchive((staging) => {
      mkdirSync(path.join(staging, 'project'));
      writeFileSync(path.join(staging, 'project', 'new.html'), 'x');
      writeFileSync(path.join(staging, 'deleted.json'), JSON.stringify(['../../../outside.txt']));
      return ['deleted.json', 'project/new.html'];
    });
    const response = await postChanges('run-escape', token, archive);
    expect(response.status).toBe(400);
    expect(readFileSync(path.join(scratch, 'outside.txt'), 'utf8')).toBe('safe');
    expect(existsSync(path.join(projectDir, 'new.html'))).toBe(false);
    child.kill('SIGKILL');
  });

  it('refuses to write through a symlink that leaves the project', async () => {
    const { token, child } = await openRun('run-symlink');
    const outside = path.join(scratch, 'elsewhere');
    mkdirSync(outside);
    symlinkSync(outside, path.join(projectDir, 'link'));
    const archive = await changesArchive((staging) => {
      mkdirSync(path.join(staging, 'project', 'link'), { recursive: true });
      writeFileSync(path.join(staging, 'project', 'link', 'evil.txt'), 'x');
      writeFileSync(path.join(staging, 'deleted.json'), '[]');
      return ['deleted.json', 'project/link/evil.txt'];
    });
    const response = await postChanges('run-symlink', token, archive);
    expect(response.status).toBe(400);
    expect(existsSync(path.join(outside, 'evil.txt'))).toBe(false);
    child.kill('SIGKILL');
  });

  it('serves and accepts a project only for the person who owns the run', async () => {
    const { child } = await openRun('run-owned');
    const bobToken = await issueToken('Bob');
    const download = await fetch(`${server.baseUrl}${workerBridgeRunProjectPath('run-owned')}`, {
      headers: { authorization: `Bearer ${bobToken}` },
    });
    expect(download.status).toBe(404);
    const upload = await postChanges('run-owned', bobToken, Buffer.alloc(0));
    expect(upload.status).toBe(404);
    child.kill('SIGKILL');
  });
});
