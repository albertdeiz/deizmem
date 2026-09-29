import type { ReactNode } from 'react';
import type { ApiError } from './api';
import { errText, type Tone } from './words';

export function Badge({ tone = '', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Status({ map, value }: { map: Record<string, [string, Tone]>; value: string }) {
  const [label, tone] = map[value] ?? [value, ''];
  return <Badge tone={tone}>{label}</Badge>;
}

export type Flash = { ok: boolean; text: ReactNode } | null;

export function Msg({ flash }: { flash: Flash }) {
  return flash ? <div className={`msg ${flash.ok ? 'ok' : 'bad'}`}>{flash.text}</div> : null;
}

export const failed = (e: ApiError): Flash => ({ ok: false, text: errText(e) });

export function Panel({ title, children, className = '' }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return <div className={`panel ${className}`}>{title ? <h2>{title}</h2> : null}{children}</div>;
}
