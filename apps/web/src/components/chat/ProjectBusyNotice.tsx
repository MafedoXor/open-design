import { useEffect, useState } from 'react';

import { useProjectCollabContext } from '../../collab/collab-context';
import { useT } from '../../i18n';
import { RUNS_CHANGED_EVENT, listActiveProjectRuns } from '../../providers/daemon';
import { projectBusyFromActiveRuns, type ProjectBusy } from '../../workers/project-busy';
import { runTargetForNextRun } from '../../workers/worker-api';
import { Icon } from '../Icon';
import styles from './ProjectBusyNotice.module.css';

/**
 * Another person's run can take the project at any time, so the server is
 * asked again on this cadence as well as whenever this browser's runs change.
 */
const PROJECT_BUSY_POLL_MS = 10_000;

/**
 * One line above the composer while the project is busy: a new run here would
 * be refused with `PROJECT_BUSY`. It is read from the server's active runs, so
 * everyone in the project sees it, and it is still there after a reload.
 */
export function ProjectBusyNotice({ projectId }: { projectId: string | null | undefined }) {
  const t = useT();
  const { workspaceContext } = useProjectCollabContext();
  const [busy, setBusy] = useState<ProjectBusy | null>(null);

  useEffect(() => {
    setBusy(null);
    if (!projectId) return;
    let cancelled = false;
    const refresh = async () => {
      const runs = await listActiveProjectRuns(projectId, workspaceContext);
      if (cancelled) return;
      setBusy(projectBusyFromActiveRuns(runs, runTargetForNextRun()?.person ?? null));
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), PROJECT_BUSY_POLL_MS);
    const onRunsChanged = () => void refresh();
    window.addEventListener(RUNS_CHANGED_EVENT, onRunsChanged);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener(RUNS_CHANGED_EVENT, onRunsChanged);
    };
  }, [projectId, workspaceContext]);

  if (!busy) return null;
  return (
    <div className={styles.notice} role="status" data-testid="project-busy-notice">
      <Icon name="lock" size={13} />
      <span>
        {busy.workerPerson
          ? t('worker.projectBusy', { person: busy.workerPerson })
          : t('worker.projectBusyOtherRun')}
      </span>
    </div>
  );
}
