import { useCallback, useEffect, useId, useState } from 'react';
import { Button, Input, Select } from '@open-design/components';
import { normalizeWorkerPerson, type WorkerStatus } from '@open-design/contracts';

import { useT } from '../i18n';
import {
  createWorkerToken,
  fetchWorkerStatus,
  readMyWorkerPerson,
  readRunOnChoice,
  revokeWorkerToken,
  workerConnectCommand,
  writeMyWorkerPerson,
  writeRunOnChoice,
  type RunOnChoice,
} from '../workers/worker-api';
import { Icon } from './Icon';
import styles from './RemoteWorkerSection.module.css';

/** Close to the server's heartbeat cadence, so "offline" shows up promptly. */
const STATUS_POLL_MS = 5_000;

interface IssuedToken {
  token: string;
  command: string;
}

/**
 * Settings → Remote worker. Shows whether this browser's person has a worker
 * connected, which agent CLIs it offers, and issues/revokes that person's
 * worker token. It is also where this browser chooses to run new messages on
 * that worker. `od worker status|token` and `od run start --worker` are the
 * CLI twins of this section.
 */
export function RemoteWorkerSection() {
  const t = useT();
  const nameId = useId();
  const runOnId = useId();
  const [runOn, setRunOn] = useState<RunOnChoice>(() => readRunOnChoice());
  const [person, setPerson] = useState<string | null>(() => readMyWorkerPerson());
  const [draft, setDraft] = useState(() => person ?? '');
  const [nameInvalid, setNameInvalid] = useState(false);
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async (who: string) => {
    try {
      const next = await fetchWorkerStatus(who);
      setStatus(next);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (!person) return;
    let cancelled = false;
    const tick = () => {
      if (!cancelled) void refresh(person);
    };
    tick();
    const timer = window.setInterval(tick, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [person, refresh]);

  const saveName = () => {
    const normalized = normalizeWorkerPerson(draft);
    if (!normalized) {
      setNameInvalid(true);
      return;
    }
    setNameInvalid(false);
    if (normalized === person) return;
    writeMyWorkerPerson(normalized);
    setStatus(null);
    setIssued(null);
    setPerson(normalized);
  };

  const chooseRunOn = (choice: RunOnChoice) => {
    writeRunOnChoice(choice);
    setRunOn(choice);
  };
  const workerUnreachable = runOn === 'my-worker' && status !== null && !status.online;

  const issueToken = async () => {
    if (!person) return;
    setBusy(true);
    try {
      const created = await createWorkerToken(person);
      setIssued({
        token: created.token,
        command: workerConnectCommand(window.location.origin, created.token),
      });
      setCopied(false);
      setFailed(false);
      await refresh(person);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const revokeToken = async () => {
    if (!person) return;
    setBusy(true);
    try {
      await revokeWorkerToken(person);
      setIssued(null);
      setFailed(false);
      await refresh(person);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const copyCommand = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.command);
      setCopied(true);
    } catch {
      // Clipboard can be unavailable on a plain-http private address; the
      // command stays selectable on screen.
    }
  };

  return (
    <section className="settings-section">
      <p className={styles.pageDesc}>{t('worker.pageDesc')}</p>

      <div className={styles.nameRow}>
        <label htmlFor={nameId} className={styles.label}>
          {t('worker.personLabel')}
        </label>
        <div className={styles.nameControls}>
          <Input
            id={nameId}
            value={draft}
            maxLength={64}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveName();
            }}
          />
          <Button type="button" variant="secondary" onClick={saveName}>
            {t('worker.saveName')}
          </Button>
        </div>
        <span className={nameInvalid ? styles.error : styles.hint} role={nameInvalid ? 'alert' : undefined}>
          {nameInvalid ? t('worker.personInvalid') : t('worker.personHint')}
        </span>
      </div>

      {person ? (
        <div className={styles.nameRow}>
          <label htmlFor={runOnId} className={styles.label}>
            {t('worker.runOnLabel')}
          </label>
          <Select
            id={runOnId}
            value={runOn}
            onChange={(event) => chooseRunOn(event.target.value === 'my-worker' ? 'my-worker' : 'server')}
          >
            <option value="server">{t('worker.runOnServer')}</option>
            <option value="my-worker">{t('worker.runOnWorker', { person })}</option>
          </Select>
          <span className={workerUnreachable ? styles.error : styles.hint} role={workerUnreachable ? 'alert' : undefined}>
            {workerUnreachable ? t('worker.runOnOffline') : t('worker.runOnHint')}
          </span>
        </div>
      ) : null}

      {person && status ? (
        <div className={styles.card}>
          <div className={styles.cardHead}>
            <span className={styles.cardTitle}>{t('worker.myWorker')}</span>
            <span className={status.online ? styles.badgeOnline : styles.badgeOffline}>
              <span className={styles.dot} aria-hidden />
              {status.online ? t('worker.statusOnline') : t('worker.statusOffline')}
            </span>
          </div>
          {status.online ? (
            <>
              <span className={styles.hint}>
                {t('worker.onHost', { host: status.hostname ?? '', platform: status.platform ?? '' })}
              </span>
              <span className={styles.label}>{t('worker.agentsTitle')}</span>
              {status.agents.length > 0 ? (
                <ul className={styles.agents}>
                  {status.agents.map((agent) => (
                    <li key={agent.id}>
                      {agent.name}
                      {agent.version ? <span className={styles.version}> {agent.version}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className={styles.hint}>{t('worker.agentsNone')}</span>
              )}
            </>
          ) : (
            <span className={styles.hint}>
              {status.hasToken ? t('worker.offlineHint') : t('worker.noTokenHint')}
            </span>
          )}
          <div className={styles.actions}>
            <Button type="button" variant="primary" disabled={busy} onClick={() => void issueToken()}>
              {status.hasToken ? t('worker.rotateToken') : t('worker.createToken')}
            </Button>
            {status.hasToken ? (
              <Button type="button" variant="ghost" disabled={busy} onClick={() => void revokeToken()}>
                {t('worker.revokeToken')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {issued ? (
        <div className={styles.card} role="status">
          <span className={styles.notice}>
            <Icon name="key" size={14} aria-hidden />
            {t('worker.tokenOnce')}
          </span>
          <code className={styles.token}>{issued.token}</code>
          <span className={styles.label}>{t('worker.runCommand')}</span>
          <code className={styles.token}>{issued.command}</code>
          <div className={styles.actions}>
            <Button type="button" variant="secondary" onClick={() => void copyCommand()}>
              <Icon name={copied ? 'check' : 'copy'} size={14} aria-hidden />
              {copied ? t('worker.copied') : t('worker.copyCommand')}
            </Button>
          </div>
        </div>
      ) : null}

      {failed ? (
        <span className={styles.error} role="alert">
          {t('worker.requestFailed')}
        </span>
      ) : null}
    </section>
  );
}
