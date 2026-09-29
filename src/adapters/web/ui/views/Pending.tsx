import { useEffect, useState } from 'react';
import { api, qs, type PendingResult } from '../api';
import { Badge, Msg, Panel, failed, type Flash } from '../kit';
import { PENDING, titleOf, when } from '../words';

/** The agent's work queue, seen by the person: what each memory still lacks. */
export function PendingView({ kind }: { kind: string | null }) {
  const [data, setData] = useState<PendingResult | null>(null);
  const [error, setError] = useState<Flash>(null);
  useEffect(() => {
    void api<PendingResult>('GET', `/api/pending${qs({ kind, limit: 100 })}`)
      .then((r) => (r.ok ? setData(r.data) : setError(failed(r.error))));
  }, [kind]);

  return (
    <Panel title="Cola de trabajo">
      <p className="muted">Lo que a cada memoria le falta para ser útil. Normalmente lo resuelve el agente.</p>
      <Msg flash={error} />
      {data ? (
        <>
          <div className="chips">
            <a href="#/pending"><Badge tone={!kind ? 'info' : ''}>Todo</Badge></a>
            {Object.entries(PENDING).map(([k, label]) => (
              <a key={k} href={`#/pending/${k}`}>
                <Badge tone={kind === k ? 'info' : data.counts[k as keyof PendingResult['counts']] ? 'warn' : ''}>
                  {label} · {data.counts[k as keyof PendingResult['counts']]}
                </Badge>
              </a>
            ))}
          </div>
          {data.items.length ? (
            <ul className="list">
              {data.items.map((m) => (
                <li key={m.id}>
                  <a href={`#/m/${m.id}`}>
                    <div className="t">{titleOf(m)}</div>
                    <div className="m">
                      <span>{when(m.capturedAt)}</span>
                      {m.reasons.map((x) => <Badge key={x} tone="warn">{PENDING[x] ?? x}</Badge>)}
                      {m.statusDetail ? <span>{m.statusDetail}</span> : null}
                    </div>
                  </a>
                </li>
              ))}
            </ul>
          ) : <div className="empty">Nada pendiente.</div>}
        </>
      ) : !error ? <p className="muted">Cargando…</p> : null}
    </Panel>
  );
}
