import { useState, type FormEvent } from 'react';
import { api, qs, type RetrieveResult } from '../api';
import { Msg, Panel, failed, type Flash } from '../kit';
import { day, short } from '../words';

/** memory_retrieve for a person: the passages, each with the memory it comes from. It does not write the answer. */
export function AskView() {
  const [q, setQ] = useState('');
  const [data, setData] = useState<RetrieveResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Flash>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    const r = await api<RetrieveResult>('GET', `/api/retrieve${qs({ query: q, limit: 15 })}`);
    setBusy(false);
    if (r.ok) { setData(r.data); setError(null); } else setError(failed(r.error));
  }

  return (
    <Panel title="Preguntar">
      <p className="muted">Devuelve los fragmentos que responden, con la memoria de la que salen. No redacta: eso es del agente.</p>
      <form onSubmit={submit} className="actions">
        <div className="grow">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="¿Cuándo vence la póliza del auto?" autoFocus />
        </div>
        <button className="primary" type="submit" disabled={busy}>{busy ? 'Buscando…' : 'Buscar'}</button>
      </form>
      <Msg flash={error} />
      {data ? (
        <>
          <p className="muted">{data.passages.length} fragmentos · vectores: {typeof data.vector === 'string' ? data.vector : JSON.stringify(data.vector)}</p>
          {data.passages.length ? data.passages.map((p) => (
            <div key={`${p.memoryId}:${p.seq}`} className="passage">
              <div>
                <a href={`#/m/${p.memoryId}`}>{p.title || `Memoria ${short(p.memoryId)}`}</a>
                <span className="muted"> · {day(p.occurredAt) || day(p.capturedAt)}{p.domain ? ` · ${p.domain}` : ''} · {p.via}</span>
              </div>
              <div className="c">{p.content}</div>
            </div>
          )) : <div className="empty">Nada coincide.</div>}
        </>
      ) : null}
    </Panel>
  );
}
