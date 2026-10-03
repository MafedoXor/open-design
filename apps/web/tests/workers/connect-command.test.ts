import { describe, expect, it } from 'vitest';

import { workerConnectCommand } from '../../src/workers/worker-api';

describe('workerConnectCommand', () => {
  it('uses the POSIX env-prefix form by default', () => {
    expect(workerConnectCommand('http://10.0.0.5:7456', 'odw_abc', 'MacIntel')).toBe(
      'OD_WORKER_TOKEN=odw_abc od worker --server http://10.0.0.5:7456',
    );
  });

  it('uses a PowerShell form on Windows, where the env-prefix form is a syntax error', () => {
    expect(workerConnectCommand('http://10.0.0.5:7456', 'odw_abc', 'Win32')).toBe(
      '$env:OD_WORKER_TOKEN = "odw_abc"; od worker --server http://10.0.0.5:7456',
    );
  });
});
