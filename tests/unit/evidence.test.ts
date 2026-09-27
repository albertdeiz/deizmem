import { describe, expect, it } from 'vitest';
import { checkField } from '../../src/core/facts/evidence';

const doc = `SEGUROS EL ROBLE S.A.
Poliza de Automovil N° BP-9344586
Vigencia: 01/03/2026 al 01/03/2027
Deducible: UF 3,0 por siniestro
MONTO FACTURADO A PAGAR (PERÍODO ANTERIOR) $886.568
MONTO TOTAL FACTURADO A PAGAR $1.747.885
Fecha de emisión: 9 Enero 2026
Asiento: 4
Asistencia en ruta 24/7: 600 600 6000`;

describe('checkField, without language', () => {
  it('accepts a number under any separator reading', () => {
    expect(checkField('money', { amount: 1747885, currency: 'clp' }, 'MONTO TOTAL FACTURADO A PAGAR $1.747.885', doc))
      .toMatchObject({ ok: true, value: { amount: 1747885, currency: 'CLP' } });
    expect(checkField('number', 3, 'Deducible: UF 3,0 por siniestro', doc).ok).toBe(true);
  });

  it('rejects a value that is not in its evidence', () => {
    expect(checkField('number', 5, 'Deducible: UF 3,0 por siniestro', doc).reason).toMatch(/not found/);
  });

  it('rejects evidence that is not in the document', () => {
    expect(checkField('number', 5, 'Deducible: 5 UF', doc).reason).toMatch(/not in the memory text/);
  });

  it('checks year and day of a date, trusting the month to the agent', () => {
    expect(checkField('date', '2026-01-09', 'Fecha de emisión: 9 Enero 2026', doc).ok).toBe(true);
    expect(checkField('date', '2026-03-01', 'Vigencia: 01/03/2026 al 01/03/2027', doc).ok).toBe(true);
    expect(checkField('date', '2026-01-10', 'Fecha de emisión: 9 Enero 2026', doc).ok).toBe(false);
    expect(checkField('date', '2026-02-30', 'Fecha de emisión: 9 Enero 2026', doc).reason).toMatch(/real date/);
  });

  it('needs the label for a short value', () => {
    expect(checkField('text', '4', '4', doc).reason).toMatch(/label/);
    expect(checkField('text', '4', 'Asiento: 4', doc).ok).toBe(true);
  });

  it('matches phone digits across spaces, and text across case and accents', () => {
    expect(checkField('phone', '6006006000', 'Asistencia en ruta 24/7: 600 600 6000', doc).ok).toBe(true);
    expect(checkField('text', 'seguros el roble', 'SEGUROS EL ROBLE S.A.', doc).ok).toBe(true);
    expect(checkField('text', 'periodo anterior', 'MONTO FACTURADO A PAGAR (PERÍODO ANTERIOR) $886.568', doc).ok).toBe(true);
  });

  it('insists on canonical values', () => {
    expect(checkField('number', '1.747.885', 'MONTO TOTAL FACTURADO A PAGAR $1.747.885', doc).reason).toMatch(/plain number/);
    expect(checkField('date', '9 Enero 2026', 'Fecha de emisión: 9 Enero 2026', doc).reason).toMatch(/YYYY-MM-DD/);
  });
});
