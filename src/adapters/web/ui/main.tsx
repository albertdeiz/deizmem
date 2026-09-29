import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import { api, setUnauthorizedHandler, type Overview } from './api';
import { Ctx, useApp } from './context';
import { Msg, type Flash } from './kit';
import { AskView } from './views/Ask';
import { CaptureView } from './views/Capture';
import { DomainsView } from './views/Domains';
import { MemoriesView } from './views/Memories';
import { PendingView } from './views/Pending';
import { SessionsView } from './views/Sessions';
import { LANES, errText } from './words';

/** Client routes live in the hash: #/m/<id>, #/pending/<kind>… The server only serves one page. */
interface Route { view: string; id: string | null }
function parse(): Route {
  const [view = 'memories', id = null] = location.hash.slice(1).split('/').filter(Boolean);
  return { view, id };
}
function useRoute(): Route {
  const [r, setR] = useState(parse);
  useEffect(() => {
    const on = () => setR(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return r;
}

const TABS: Array<[string, string]> = [
  ['memories', 'Memorias'], ['pending', 'Pendientes'], ['ask', 'Preguntar'],
  ['capture', 'Capturar'], ['domains', 'Categorías'], ['sessions', 'Sesiones'],
];

function Header({ view, onLogout }: { view: string; onLogout: () => void }) {
  const { overview: o } = useApp();
  const p = o?.pending;
  const queue = p ? p.needs_text + p.unclassified + p.review + p.failed : 0;
  const active = view === 'm' ? 'memories' : view;
  return (
    <header>
      <span className="brand">deizmem</span>
      <nav>
        {TABS.map(([k, label]) => (
          <a key={k} href={`#/${k}`} className={active === k ? 'on' : ''}>
            {label}{k === 'pending' && queue ? <span className="count">{queue}</span> : null}
          </a>
        ))}
      </nav>
      <div className="health">
        {o?.db ? <span className={`dot ${o.db.ok ? 'ok' : 'bad'}`} title={o.db.detail}>base</span> : null}
        {o ? Object.entries(o.lanes).map(([k, l]) => (
          <span key={k} className={`dot ${l === 'off' ? '' : l.ok ? 'ok' : 'bad'}`} title={l === 'off' ? 'apagado' : l.detail}>{LANES[k] ?? k}</span>
        )) : null}
        <button onClick={onLogout} title="Revoca esta sesión">Salir</button>
      </div>
    </header>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('web');
  const [flash, setFlash] = useState<Flash>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await api('POST', '/api/login', { code, label });
    if (!r.ok) {
      return setFlash({ ok: false, text: r.error.status === 403 ? 'El código no existe, ya se usó o expiró.' : errText(r.error) });
    }
    location.hash = '#/';
    onDone();
  }
  return (
    <div className="login panel">
      <h2>Conectar este navegador</h2>
      <p className="muted">En el Pi, genera un código de un solo uso (dura 15 minutos):</p>
      <p><code>scripts/pi.sh dm pair</code></p>
      <form onSubmit={submit}>
        <label>Código</label>
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD2345" autoFocus
          autoComplete="off" autoCapitalize="characters" spellCheck={false} />
        <label>Nombre de la sesión</label>
        <input value={label} onChange={(e) => setLabel(e.target.value)} />
        <div className="actions"><button className="primary" type="submit">Entrar</button></div>
      </form>
      <Msg flash={flash} />
    </div>
  );
}

function App() {
  const route = useRoute();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);

  const refresh = useCallback(async () => {
    const r = await api<Overview>('GET', '/api/overview');
    if (r.ok) { setOverview(r.data); setAuthed(true); }
    else if (r.error.status === 401) setAuthed(false);
  }, []);

  useEffect(() => { setUnauthorizedHandler(() => setAuthed(false)); void refresh(); }, [refresh]);

  async function logout() {
    await api('POST', '/api/logout');
    setOverview(null);
    setAuthed(false);
  }

  if (authed === null) return <p className="boot">Cargando…</p>;
  if (!authed) return <Login onDone={refresh} />;

  const views: Record<string, ReactElement> = {
    memories: <MemoriesView id={null} />, m: <MemoriesView id={route.id} />,
    pending: <PendingView kind={route.id} />, ask: <AskView />, capture: <CaptureView />,
    domains: <DomainsView />, sessions: <SessionsView />,
  };
  return (
    <Ctx.Provider value={{ overview, refresh }}>
      <Header view={route.view} onLogout={logout} />
      <main>{views[route.view] ?? views.memories}</main>
    </Ctx.Provider>
  );
}

createRoot(document.getElementById('app')!).render(<App />);
