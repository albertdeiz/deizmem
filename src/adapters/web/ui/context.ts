import { createContext, useContext } from 'react';
import type { Overview } from './api';

/** What every view shares: the header's overview, and a way to refresh it after a change. */
export interface AppCtx { overview: Overview | null; refresh: () => Promise<void> }
export const Ctx = createContext<AppCtx>({ overview: null, refresh: async () => {} });
export const useApp = () => useContext(Ctx);
