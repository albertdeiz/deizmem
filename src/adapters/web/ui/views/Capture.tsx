import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import { api, qs, type CaptureResult } from '../api';
import { useApp } from '../context';
import { Msg, Panel, failed, type Flash } from '../kit';
import { errText, isPdf, passwordHeader, short, size, splitTags } from '../words';

/** Capture never asks for a category: it stores now and reads later (§3.1). */
export function CaptureView() {
  const { refresh } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [note, setNote] = useState('');
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [tags, setTags] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash>(null);

  function drop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    pick(e.dataTransfer.files[0] ?? null);
  }

  /** A new file never inherits the last one's password. */
  function pick(f: File | null) {
    setFile(f);
    setPassword('');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file && !note.trim()) return setFlash({ ok: false, text: 'Elige un archivo o escribe una nota.' });
    setBusy(true);
    const tagList = splitTags(tags);
    const r = file
      ? await api<CaptureResult>('POST', `/api/capture${qs({
        filename: file.name, media_type: file.type, note: note.trim(), title: title.trim(), occurred_at: date, tag: tagList,
      })}`, file, { type: file.type, headers: passwordHeader(isPdf(file) ? password : '') })
      : await api<CaptureResult>('POST', '/api/capture', { note, title, occurred_at: date, tags: tagList });
    setBusy(false);
    setPassword('');
    if (!r.ok) return setFlash(failed(r.error));
    const link = <a href={`#/m/${r.data.id}`}>Ver memoria {short(r.data.id)}</a>;
    const u = r.data.unlock;
    // Stored either way; a password that did not open it is said, not hidden.
    setFlash(u
      ? { ok: false, text: <>Guardada, pero sin leer. {errText({ status: 0, ...u })}. Puedes probar otra contraseña desde la memoria. {link}</> }
      : { ok: true, text: <>{r.data.deduped ? 'Ya estaba guardada. ' : 'Guardada. '}{link}</> });
    setFile(null); setNote(''); setTitle(''); setDate(''); setTags('');
    if (input.current) input.current.value = '';
    void refresh();
  }

  return (
    <Panel title="Capturar" className="narrow">
      <p className="muted">Se guarda al instante; la lectura del archivo ocurre después. No hace falta categoría.</p>
      <form onSubmit={submit}>
        <div className={`drop ${over ? 'over' : ''}`} onClick={() => input.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}>
          {file ? `${file.name} · ${size(file.size)}` : 'Arrastra un archivo aquí o haz clic para elegirlo'}
        </div>
        <input ref={input} type="file" hidden onChange={(e) => pick(e.target.files?.[0] ?? null)} />
        {file && isPdf(file) ? (
          <>
            <label>Contraseña del PDF, si tiene</label>
            <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="Se usa una vez para leerlo y no se guarda" />
          </>
        ) : null}
        <label>Nota</label>
        <textarea className="prose" value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="Tus palabras: de qué es, por qué lo guardas. Puede ir sola, sin archivo." />
        <div className="form-row">
          <div><label>Título</label><input value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div><label>Fecha del hecho</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        </div>
        <label>Etiquetas</label>
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="separadas por coma" />
        <div className="actions"><button className="primary" type="submit" disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</button></div>
      </form>
      <Msg flash={flash} />
    </Panel>
  );
}
