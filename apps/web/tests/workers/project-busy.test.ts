import { describe, expect, it } from 'vitest';

import { projectBusyFromActiveRuns } from '../../src/workers/project-busy';

describe('projectBusyFromActiveRuns', () => {
  it('is busy while a run on someone\'s worker is active, naming that person', () => {
    expect(
      projectBusyFromActiveRuns(
        [{ status: 'running', workerPerson: 'Alice' }],
        null,
      ),
    ).toEqual({ workerPerson: 'Alice' });
  });

  it('is not busy when only server runs are active and new runs also go to the server', () => {
    expect(
      projectBusyFromActiveRuns([{ status: 'running', workerPerson: null }], null),
    ).toBeNull();
  });

  it('is busy for a person whose new runs go to their worker while any run is active', () => {
    expect(
      projectBusyFromActiveRuns([{ status: 'queued' }], 'Bob'),
    ).toEqual({ workerPerson: null });
  });

  it('ignores runs that already ended', () => {
    expect(
      projectBusyFromActiveRuns(
        [
          { status: 'succeeded', workerPerson: 'Alice' },
          { status: 'failed', workerPerson: 'Alice' },
          { status: 'canceled', workerPerson: 'Alice' },
        ],
        'Bob',
      ),
    ).toBeNull();
  });
});
