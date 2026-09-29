import { useEffect, useState } from 'react';
import { api, type Domain, type FactType } from '../api';
import { Badge, Msg, Panel, failed, type Flash } from '../kit';
import { filterByDomain } from './Memories';

/** Read-only: categories and types change through the agent, with the person's confirm (hard rule 7). */
export function DomainsView() {
  const [domains, setDomains] = useState<Domain[] | null>(null);
  const [types, setTypes] = useState<FactType[] | null>(null);
  const [error, setError] = useState<Flash>(null);
  useEffect(() => {
    void api<{ domains: Domain[] }>('GET', '/api/domains').then((r) => (r.ok ? setDomains(r.data.domains) : setError(failed(r.error))));
    void api<{ types: FactType[] }>('GET', '/api/fact-types').then((r) => (r.ok ? setTypes(r.data.types) : setError(failed(r.error))));
  }, []);

  return (
    <>
      <Msg flash={error} />
      <Panel title="Categorías">
        <p className="muted">La descripción es lo que el agente lee para clasificar. Se crean y editan desde el agente, con tu confirmación.</p>
        {!domains ? <p className="muted">Cargando…</p> : !domains.length ? <p className="empty">Todavía no hay categorías.</p> : (
          <div className="scroll">
            <table>
              <thead><tr><th>Categoría</th><th>Descripción</th><th>Memorias</th><th /></tr></thead>
              <tbody>
                {domains.map((d) => (
                  <tr key={d.slug}>
                    <td><strong>{d.label}</strong><div className="muted">{d.slug}</div></td>
                    <td>{d.description}</td>
                    <td className="num"><a href="#/memories" onClick={() => filterByDomain(d.slug)}>{d.memories}</a></td>
                    <td>{d.active ? null : <Badge>archivada</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel title="Tipos de hecho">
        {!types ? <p className="muted">Cargando…</p> : !types.length ? <p className="empty">Todavía no hay tipos.</p> : types.map((t) => (
          <div key={t.slug} className="fact">
            <div className="head">
              <strong>{t.slug}</strong>
              <Badge tone="info">{t.kind}</Badge><Badge>{t.cardinality}</Badge>
              {t.domainSlug ? <span className="muted">{t.domainSlug}</span> : null}
              {t.active ? null : <Badge>archivado</Badge>}
            </div>
            <p className="muted flush">{t.description}</p>
            <div className="scroll">
              <table>
                <thead><tr><th>Campo</th><th>Tipo</th><th>Descripción</th></tr></thead>
                <tbody>
                  {t.fields.map((f) => (
                    <tr key={f.name}>
                      <td>{f.name}{t.identityField === f.name ? ' (identidad)' : ''}</td>
                      <td>{f.kind}</td><td>{f.description ?? f.label ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </Panel>
    </>
  );
}
