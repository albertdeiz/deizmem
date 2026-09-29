import { useCallback, useEffect, useState } from 'react';
import { api, type SessionSummary } from '../api';
import { Badge, Msg, Panel, failed, type Flash } from '../kit';
import { day, short, when } from '../words';

/** Every agent and browser has its own session; revoking cuts it at once (§9). */
export function SessionsView() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [flash, setFlash] = useState<Flash>(null);
  const load = useCallback(async () => {
    const r = await api<{ sessions: SessionSummary[] }>('GET', '/api/sessions');
    if (r.ok) setSessions(r.data.sessions); else setFlash(failed(r.error));
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function revoke(s: SessionSummary) {
    if (!confirm(`¿Revocar la sesión "${s.label ?? short(s.id)}"? El agente o navegador que la usa pierde el acceso.`)) return;
    const r = await api('POST', `/api/sessions/${s.id}/revoke`);
    setFlash(r.ok ? { ok: true, text: `Sesión ${s.label ?? short(s.id)} revocada.` } : failed(r.error));
    void load();
  }

  return (
    <Panel title="Sesiones">
      <p className="muted">Cada agente y cada navegador conectado tiene la suya. Revocar corta el acceso al instante.</p>
      <Msg flash={flash} />
      {!sessions ? <p className="muted">Cargando…</p> : (
        <div className="scroll">
          <table>
            <thead><tr><th>Nombre</th><th>Id</th><th>Creada</th><th>Último uso</th><th>Estado</th><th /></tr></thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>{s.label ?? '—'}</td><td><code>{short(s.id)}</code></td>
                  <td>{when(s.createdAt)}</td><td>{s.lastUsedAt ? when(s.lastUsedAt) : 'nunca'}</td>
                  <td>{s.revoked ? <Badge>revocada</Badge> : <Badge tone="ok">hasta {day(s.expiresAt)}</Badge>}</td>
                  <td>{s.revoked ? null : <button className="danger" onClick={() => void revoke(s)}>Revocar</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
