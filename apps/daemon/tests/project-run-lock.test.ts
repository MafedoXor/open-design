import { describe, expect, it } from 'vitest';
import { findProjectRunLock, ProjectBusyError } from '../src/workers/project-run-lock.js';

const active = (id: string, workerPerson?: string) => ({ id, workerPerson });

describe('project run lock', () => {
  it('blocks a worker run while another run is active in the project', () => {
    const lock = findProjectRunLock({ activeRuns: [active('a')], newRunWorkerPerson: 'Bob', excludeRunId: 'new' });
    expect(lock?.runId).toBe('a');
  });

  it('blocks a server run while a worker run is active in the project', () => {
    const lock = findProjectRunLock({ activeRuns: [active('a', 'Alice')], newRunWorkerPerson: null, excludeRunId: 'new' });
    expect(lock).toMatchObject({ runId: 'a', workerPerson: 'Alice' });
  });

  it('lets server runs share a project with other server runs', () => {
    expect(findProjectRunLock({ activeRuns: [active('a')], newRunWorkerPerson: null, excludeRunId: 'new' })).toBeNull();
  });

  it('never blocks a run on itself', () => {
    expect(findProjectRunLock({ activeRuns: [active('new', 'Alice')], newRunWorkerPerson: 'Alice', excludeRunId: 'new' })).toBeNull();
  });

  it('names who holds the project in the refusal', () => {
    const error = new ProjectBusyError({ runId: 'a', workerPerson: 'Alice' });
    expect(error.code).toBe('PROJECT_BUSY');
    expect(error.message).toMatch(/busy/i);
    expect(error.message).toMatch(/Alice/);
  });
});
