import { describe, expect, it } from 'vitest';
import { containsNumber, fold, readings, readingsOfValue, tokens } from '../../src/core/text';
import { chunkText } from '../../src/core/chunk';
import { detectMediaType, laneFor } from '../../src/core/media';

describe('fold and tokens', () => {
  it('drops accents and case, collapses space', () => {
    expect(fold('  Vehículo   ÑANDÚ ')).toBe('vehiculo nandu');
    expect(tokens('Póliza N°BP-9344586')).toEqual(['poliza', 'n', 'bp', '9344586']);
  });
});

describe('number readings, no locale', () => {
  it('keeps both readings of an ambiguous separator', () => {
    expect(readings('1.500')).toEqual(new Set(['1500', '1.5']));
    expect(readings('$886.568')).toContain('886568');
  });
  it('treats a zero fraction as the integer', () => {
    expect(readings('3,0')).toContain('3');
    expect(readingsOfValue(3)).toEqual(new Set(['3']));
  });
  it('finds a canonical value inside written text', () => {
    expect(containsNumber('MONTO TOTAL $1.747.885', readingsOfValue(1747885))).toBe(true);
    expect(containsNumber('UF 3,0 deducible', readingsOfValue('3'))).toBe(true);
    expect(containsNumber('UF 3,5 deducible', readingsOfValue(3))).toBe(false);
  });
});

describe('chunkText', () => {
  it('keeps short text whole and splits long paragraphs', () => {
    expect(chunkText('hola')).toEqual(['hola']);
    const long = Array.from({ length: 40 }, (_, i) => `Párrafo ${i} ${'x'.repeat(80)}`).join('\n\n');
    const chunks = chunkText(long);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
  });
});

describe('media', () => {
  it('sniffs magic bytes before trusting the name', () => {
    expect(detectMediaType(Buffer.from('%PDF-1.7'), 'x.txt')).toBe('application/pdf');
    expect(detectMediaType(Buffer.from('hola'), 'notas.md')).toBe('text/markdown');
    expect(laneFor('image/heic')).toBe('vision');
    expect(laneFor('text/plain')).toBe('inline');
    expect(laneFor('application/pdf')).toBe('document');
  });
});
