import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, qs, type FactHit, type Memory, type MemorySummary } from '../api';
import { useApp } from '../context';
import { Badge, Msg, Panel, Status, failed, type Flash } from '../kit';
import { FACT_STATUS, LANE, STATUS, day, isPdf, splitTags, titleOf, value, when } from '../words';

interface Filters { query: string; domain: string; status: string; hidden: boolean }
interface Page { items: MemorySummary[]; next: number | null }

// Kept across views, so coming back from a detail keeps the search.
let lastFilters: Filters = { query: '', domain: '', status: '', hidden: false };
export const filterByDomain = (slug: string) => { lastFilters = { ...lastFilters, domain: slug }; };

export function MemoriesView({ id }: { id: string | null }) {
  const { overview } = useApp();
  const [f, setF] = useState<Filters>(lastFilters);
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<Flash>(null);
  const [version, setVersion] = useState(0);

  const load = useCallback(async (cursor: number | null, prev: MemorySummary[]) => {
    const r = await api<Page>('GET', `/api/memories${qs({
      query: f.query, domain: f.domain, status: f.status, hidden: f.hidden ? '1' : '', limit: 30, cursor,
    })}`);
    if (!r.ok) return setError(failed(r.error));
    setError(null);
    setPage({ items: [...prev, ...r.data.items], next: r.data.next });
  }, [f]);

  useEffect(() => {
    lastFilters = f;
    const t = setTimeout(() => void load(null, []), 250);
    return () => clearTimeout(t);
  }, [f, load, version]);

  const set = (patch: Partial<Filters>) => setF((x) => ({ ...x, ...patch }));
  const domains = overview?.domains ?? [];

  return (
    <div className="split">
      <Panel>
        <div className="filters">
          <div className="wide">
            <input type="search" placeholder="Buscar en título, etiquetas y texto" value={f.query}
              onChange={(e) => set({ query: e.target.value })} />
          </div>
          <select value={f.domain} onChange={(e) => set({ domain: e.target.value })}>
            <option value="">Todas las categorías</option>
            {domains.map((d) => <option key={d.slug} value={d.slug}>{d.label}</option>)}
          </select>
          <select value={f.status} onChange={(e) => set({ status: e.target.value })}>
            <option value="">Todos los estados</option>
            {Object.entries(STATUS).map(([k, [label]]) => <option key={k} value={k}>{label}</option>)}
          </select>
          <label className="check wide">
            <input type="checkbox" checked={f.hidden} onChange={(e) => set({ hidden: e.target.checked })} /> Incluir ocultas
          </label>
        </div>
        <Msg flash={error} />
        {!page ? <p className="muted">Cargando…</p> : !page.items.length ? <div className="empty">No hay memorias que coincidan.</div> : (
          <>
            <ul className="list">
              {page.items.map((m) => (
                <li key={m.id}>
                  <a href={`#/m/${m.id}`} className={m.id === id ? 'on' : ''}>
                    <div className="t">{titleOf(m)}</div>
                    <div className="m">
                      <span>{day(m.occurredAt) || day(m.capturedAt)}</span>
                      {m.domain ? <span>{m.domain}</span> : null}
                      {m.status !== 'ready' ? <Status map={STATUS} value={m.status} /> : null}
                      {m.needsReview ? <Badge tone="warn">revisar</Badge> : null}
                      {m.hidden ? <Badge>oculta</Badge> : null}
                    </div>
                  </a>
                </li>
              ))}
            </ul>
            {page.next !== null ? <button className="more" onClick={() => void load(page.next, page.items)}>Cargar más</button> : null}
          </>
        )}
      </Panel>
      <div className="detail">
        {id ? <Detail key={id} id={id} onChanged={() => setVersion((v) => v + 1)} />
          : <Panel className="empty">Elige una memoria de la lista.</Panel>}
      </div>
    </div>
  );
}

function Detail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { refresh } = useApp();
  const [m, setM] = useState<Memory | null>(null);
  const [error, setError] = useState<Flash>(null);
  const [flash, setFlash] = useState<Flash>(null);

  const load = useCallback(async () => {
    const r = await api<Memory>('GET', `/api/memories/${id}`);
    if (r.ok) setM(r.data); else setError(failed(r.error));
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  /** After a write: say how it went, then reload this memory, the list and the header. */
  async function done(r: Awaited<ReturnType<typeof api>>, ok: string) {
    if (!r.ok) return setFlash(failed(r.error));
    setFlash({ ok: true, text: ok });
    await Promise.all([load(), refresh()]);
    onChanged();
  }

  if (error) return <Panel><Msg flash={error} /></Panel>;
  if (!m) return <Panel className="muted">Cargando…</Panel>;

  const original = `/api/memories/${m.id}/original`;
  const t = m.mediaType ?? '';
  let preview = null;
  if (m.sha256) {
    if (t.startsWith('image/')) preview = <img src={original} alt={titleOf(m)} />;
    else if (t === 'application/pdf') preview = <iframe src={original} title={titleOf(m)} />;
    else if (t.startsWith('audio/')) preview = <audio src={original} controls />;
    else if (t.startsWith('video/')) preview = <video src={original} controls />;
  }

  return (
    <>
      <Panel>
        <h2>{titleOf(m)}</h2>
        <div className="m">
          <Status map={STATUS} value={m.status} />{' '}
          {m.needsReview ? <Badge tone="warn">revisar</Badge> : null}{' '}
          {m.hidden ? <Badge>oculta</Badge> : null}
        </div>
        <dl className="meta">
          <dt>Id</dt><dd><code>{m.id}</code></dd>
          <dt>Fecha del hecho</dt><dd>{day(m.occurredAt) || '—'}</dd>
          <dt>Capturada</dt><dd>{when(m.capturedAt)}</dd>
          <dt>Categoría</dt>
          <dd>
            {m.domain ?? '—'}
            {m.classifiedBy ? <span className="muted"> · por {m.classifiedBy}
              {m.domainConfidence !== null ? ` (${Math.round(m.domainConfidence * 100)}%)` : ''}</span> : null}
          </dd>
          <dt>Etiquetas</dt><dd>{m.tags.length ? m.tags.join(', ') : '—'}</dd>
          <dt>Archivo</dt><dd>{m.filename ? `${m.filename} · ${t}` : m.sha256 ? t : 'solo texto'}</dd>
          <dt>Lectura</dt><dd>{(m.lane ? LANE[m.lane] ?? m.lane : '—') + (m.statusDetail ? ` · ${m.statusDetail}` : '')}</dd>
          <dt>Hechos</dt><dd>{m.factsCheckedAt ? `revisados ${when(m.factsCheckedAt)}` : 'sin revisar'}</dd>
        </dl>
        <div className="actions">
          {m.sha256 ? <a href={original} target="_blank" rel="noopener"><button>Abrir original</button></a> : null}
          {m.sha256 ? <a href={`${original}?download=1`}><button>Descargar</button></a> : null}
          {canReread(m) ? (
            <button title="Pasa el archivo otra vez por los carriles: sirve si uno estaba apagado o falló"
              onClick={async () => done(await api('POST', `/api/memories/${m.id}/reread`),
                'Se vuelve a leer en segundo plano. Recarga en unos segundos.')}>
              Volver a leer
            </button>
          ) : null}
          <button onClick={async () => done(await api('POST', `/api/memories/${m.id}/hide`, { hidden: !m.hidden }),
            m.hidden ? 'Visible de nuevo.' : 'Oculta. No se borró nada.')}>
            {m.hidden ? 'Mostrar' : 'Ocultar'}
          </button>
        </div>
        <Msg flash={flash} />
        {m.note ? <><h3>Nota</h3><div className="note">{m.note}</div></> : null}
        {preview ? <div className="preview">{preview}</div> : null}
      </Panel>

      {canUnlock(m) ? <UnlockForm m={m} done={done} /> : null}

      <Panel title="Hechos">
        {m.facts.length ? m.facts.map((f) => <Fact key={f.id} f={f} />)
          : <p className="muted">{m.factsCheckedAt ? 'Revisada: ningún tipo aplica.' : 'Todavía nadie extrajo hechos de esta memoria.'}</p>}
      </Panel>

      <ClassifyForm m={m} done={done} />

      <Panel title="Texto">
        {m.text ? <pre className="text">{m.text}</pre> : <p className="muted">Ningún carril pudo leerla.</p>}
        <TextForm m={m} done={done} />
      </Panel>
    </>
  );
}

/** Hard rule 10: expired, superseded or in conflict is said before the value. */
function Fact({ f }: { f: FactHit }) {
  return (
    <div className="fact">
      <div className="head">
        <Status map={FACT_STATUS} value={f.status} />
        <strong>{f.type}</strong>
        <span className="muted">{f.identity}</span>
      </div>
      <div className="scroll">
        <table>
          <thead><tr><th>Campo</th><th>Valor</th><th>Evidencia</th></tr></thead>
          <tbody>
            {Object.entries(f.payload).map(([k, v]) => (
              <tr key={k}><td>{k}</td><td className="num">{value(v)}</td><td className="ev">{f.evidence[k] ?? ''}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="muted small">
        {f.validFrom || f.validUntil ? `Vigencia ${day(f.validFrom) || '…'} → ${day(f.validUntil) || '…'} · ` : ''}por {f.extractedBy}
      </div>
    </div>
  );
}

type Done = (r: Awaited<ReturnType<typeof api>>, ok: string) => Promise<void>;

/** The same rules as the core's reread: a file the lanes read, not text someone wrote. */
const canReread = (m: Memory) => !!m.sha256 && m.lane !== 'agent' && !m.passwordProtected && m.status !== 'pending';
const canUnlock = (m: Memory) => !!m.sha256 && isPdf({ name: m.filename ?? '', type: m.mediaType })
  && (m.status === 'needs_text' || m.status === 'failed' || (m.status === 'ready' && m.passwordProtected));

/** The person types it here, so it never goes through the agent's LLM. */
function UnlockForm({ m, done }: { m: Memory; done: Done }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const again = m.status === 'ready';
  return (
    <Panel title={again ? 'Volver a leer con contraseña' : 'Abrir con contraseña'}>
      <p className="muted">
        {again ? 'Se leyó con una contraseña, que no se guardó. Para leerlo otra vez hace falta de nuevo.'
          : 'Si el PDF tiene contraseña, escríbela aquí. Se usa una vez para leerlo y no se guarda.'}
      </p>
      <form onSubmit={async (e) => {
        e.preventDefault();
        if (!password) return;
        setBusy(true);
        const r = await api('POST', `/api/memories/${m.id}/unlock`, { password });
        setBusy(false);
        setPassword('');
        await done(r, 'Leído. Se vuelve a indexar.');
      }}>
        <label>Contraseña</label>
        <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
        <div className="actions">
          <button className="primary" type="submit" disabled={busy || !password}>{busy ? 'Leyendo…' : 'Abrir'}</button>
        </div>
      </form>
    </Panel>
  );
}

function ClassifyForm({ m, done }: { m: Memory; done: Done }) {
  const { overview } = useApp();
  const [domain, setDomain] = useState(m.domain ?? '');
  const [title, setTitle] = useState(m.title ?? '');
  const [date, setDate] = useState(day(m.occurredAt));
  const [tags, setTags] = useState(m.tags.join(', '));
  async function submit(e: FormEvent) {
    e.preventDefault();
    done(await api('POST', `/api/memories/${m.id}/classify`, {
      domain: domain || null, title, occurred_at: date, tags: splitTags(tags),
    }), 'Guardado.');
  }
  return (
    <Panel title="Clasificar">
      <form onSubmit={submit}>
        <div className="form-row">
          <div>
            <label>Categoría</label>
            <select value={domain} onChange={(e) => setDomain(e.target.value)}>
              <option value="">Sin categoría</option>
              {(overview?.domains ?? []).map((d) => <option key={d.slug} value={d.slug}>{d.label}</option>)}
            </select>
          </div>
          <div><label>Fecha del hecho</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        </div>
        <label>Título</label><input value={title} onChange={(e) => setTitle(e.target.value)} />
        <label>Etiquetas</label>
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="separadas por coma" />
        <div className="actions"><button className="primary" type="submit">Guardar</button></div>
      </form>
    </Panel>
  );
}

function TextForm({ m, done }: { m: Memory; done: Done }) {
  const [text, setText] = useState(m.text ?? '');
  const open = m.status === 'needs_text';
  const form = (
    <form onSubmit={async (e) => {
      e.preventDefault();
      done(await api('POST', `/api/memories/${m.id}/text`, { text }), 'Texto guardado. Se vuelve a indexar.');
    }}>
      <label>{open ? 'Escribe el texto que ningún carril pudo leer' : 'Reemplazar el texto extraído (la nota no se toca)'}</label>
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Lo que dice el documento, tal cual." />
      <div className="actions"><button className="primary" type="submit">Guardar texto</button></div>
    </form>
  );
  return open ? form : <details><summary className="muted summary">Corregir el texto</summary>{form}</details>;
}
