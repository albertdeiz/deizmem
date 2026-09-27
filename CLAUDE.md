# deizmem

Memoria personal externa **como servicio**. Guarda lo que le mandan (archivo o nota) y lo
devuelve con evidencia. **No conversa, no clasifica y no redacta**: eso lo hace el agente que
la usa (Hermes Agent, OpenClaw o el que sea) por MCP.

**Frase de una línea:** _el agente piensa, la memoria recuerda y verifica._

Proyecto nuevo, empezado de cero el 2026-09-27. Su antecesor es `~/Dev/deiz-memory`: de ahí
viene el diseño, y su CLAUDE.md guarda las mediciones que lo justifican. Este documento
describe **lo que está decidido**. §11 dice qué está construido.

---

## 1. Problema

1. **Recuperación imposible bajo presión.** El dato existe (la póliza, la receta, el número
   de emergencia), pero encontrarlo requiere 10 minutos y calma.
2. **Datos que caducan sin avisar.** El riesgo no es olvidarlos: es consultarlos y recibir
   el dato viejo sin darse cuenta.
3. **Capturar tiene que costar un gesto.** Ese gesto ahora lo ofrece el agente, que es el
   que está en el chat. La memoria solo tiene que aceptar cualquier cosa, sin preguntas.

## 2. Frontera y no-objetivos

| El agente | La memoria |
|---|---|
| conversación, canal, idioma | guardar el original, intacto |
| elegir y pagar el LLM | sacar texto con carriles enchufables |
| clasificar, extraer hechos, redactar | indexar (léxico y vectores) |
| decidir la intención | guardar lo que el agente decide, **verificado contra el documento** |
| pedir confirmaciones a la persona | devolver evidencia citable, con su vigencia |

- **No corre LLMs.** Los modelos que sí corre (OCR, Whisper, embeddings) **transforman sin
  decidir**, y cada uno es opcional. Si un modelo interpreta el contenido, es del agente.
- **No tiene canal propio** ni estado de conversación: dos llamadas en cualquier orden dan
  lo mismo.
- **No sabe idiomas.** Ninguna regla reconoce una palabra: compara dígitos, tokens o
  fragmentos literales (§6).
- **No borra**, salvo `purge`, que es explícito y auditado, y nunca está en MCP.
- **No sale del host.** Todo escucha en `127.0.0.1` o en una red de Docker.
- No es un Drive, ni un CRM, ni una app de finanzas: sumar filas no es un hecho (§4).

## 3. Principios

1. **Captura sin fricción.** Guardar nunca exige categoría. Clasificar es un paso posterior.
2. **Nunca inventar.** Todo lo que se devuelve trae su `memory_id`. Todo hecho guardado trae
   el fragmento literal del que salió, verificado en código.
3. **El tiempo es de primera clase.** La fecha de captura y la fecha del hecho son columnas
   distintas, y se ordena por la del hecho.
4. **Confirmación diferida.** Lo dudoso se guarda igual y va a la cola de trabajo.
5. **Datos, no respuestas.** El core devuelve filas y `code` estables en inglés. La prosa es
   del agente.
6. **El original es sagrado.** El blob nunca se toca. Lo que produce un carril se recalcula.
   Lo que produjo el agente lleva `by` y se vuelve a encolar.
7. **Las categorías y los tipos son datos**, nunca un enum. Agregar uno no requiere deploy.
8. **Cabe en un Raspberry Pi 4.** Cada contenedor se justifica contra 8 GB de RAM y una SD.

## 4. Modelo de datos

**`memories`**: `owner_id` · `source` · `captured_at` · `occurred_at` · `blob_sha256` ·
`filename` · `media_type` · `note` (lo que escribió la persona, nunca se pisa) ·
`normalized_text` (lo que sacó un carril o puso el agente) · `lane`
(`inline | document | vision | audio | agent`) · `status` · `domain_id` ·
`domain_confidence` · `classified_by` · `needs_review` · `title` · `tags` ·
`facts_checked_at` · `hidden`.

`status`: `pending` (se está leyendo) → `ready` (tiene texto) · `needs_text` (ningún carril
pudo leerla, y espera al agente) · `failed`.

**`domains`**: `slug` · `label` · `description` (que es el prompt del agente) · `active`.

**`fact_types`**: `slug` · `kind` (`estado | periodo`) · `cardinality` (`one | many`) ·
`description` · `domain_slug` (orienta, no filtra) · `fields[{name, kind, label,
description}]` · `identity_field` · `active`. Los kinds de campo son `text · number ·
money · date · phone`, y `money` trae `{amount, currency}`.

**`facts`**: `memory_id` · `type_id` · `identity` · `payload` · `evidence` (un fragmento por
campo) · `valid_from` · `valid_until` · `superseded_by` · `confidence` · `extracted_by`.
Es único por `(memory_id, type_id, identity)`.

- **`estado`** tiene uno vigente: con el mismo tipo y la misma identidad, si las vigencias no
  se solapan, el posterior supera al anterior. Si se solapan, es un **conflicto** y se
  muestran los dos. **Compartir el día de corte no es solaparse**: una póliza "01/03/2025
  al 01/03/2026" seguida de otra desde el 01/03/2026 es una sucesión. Si falta `valid_until`,
  también se lee como sucesión. La identidad se compara normalizada: `BP-9344586` y
  `bp 9344586` son la misma.
- **`periodo`** coexiste: la cartola de julio sigue siendo verdad sobre julio.
- **`many`** exige `identity_field`. **Instancia no es tabla**: si la pregunta natural
  empieza con "cuánto en total", no es un tipo.

**Otras tablas:** `owners` · `blobs` (sha256, sin dueño: se dedupean por contenido) ·
`chunks` · `embedding_spaces` y `chunk_embeddings` (§7) · `sessions` y `pairing_codes` (§9)
· `jobs` (la cola del worker) · `audit_log`.

## 5. Operaciones e interfaz

Toda operación es `(deps, actor, input) → Result<T>`. Hay tres adapters sin lógica de
negocio: **MCP** (el agente), **CLI** (el operador) y, más adelante, una API para una web.

**MCP es la interfaz del agente**, y no el CLI, porque un agente con el CLI necesita shell,
y el CLI trae `purge`. Herramientas:

```
memory_capture   memory_search    memory_retrieve  memory_get      memory_original
memory_set_text  memory_classify  memory_hide      pending_list
facts_put        facts_query      fact_types_list  domains_list    verify
domain_create · domain_edit · domain_archive · domain_merge
fact_type_create · fact_type_edit · fact_type_archive
```

- **Ninguna recibe el dueño.** Sale del token (regla dura 9).
- Un error es `isError` con `{code, message}`. Una confirmación pendiente es `{code:
  "requires_confirmation", affects}`, y el agente reintenta con `confirm: true`.
- **No se expone:** `purge`, `reprocess`, `pair`, sesiones, ni nada genérico.
- **El contrato** (reglas duras 1-6 y 10) viaja en el `instructions` del servidor y en
  `skills/deizmem/SKILL.md`.

**`pending_list`** es la cola de trabajo del agente: `needs_text` · `unclassified` ·
`unextracted` (tiene texto pero `facts_checked_at` es null) · `review`.

## 6. Verificar sin idioma

**Evidencia de un hecho.** Por cada campo, `facts_put` recibe `{value, evidence}`:

1. La evidencia está en el texto de la memoria, tras NFKC, casefold, sin tildes y con los
   espacios colapsados.
2. El valor está en la evidencia, según el kind del campo:
   - `number`, `money` y `phone`: se comparan las secuencias de dígitos, probando las
     lecturas de los separadores (`1.500` puede ser 1500 o 1,5).
   - `date`: el año y el día aparecen como números. **El mes lo afirma el agente.**
   - `text`: el valor normalizado está contenido en la evidencia.
3. Un valor de 2 caracteres o menos exige una evidencia más larga que él: hay que citar la
   línea con su rótulo.

Lo que no pasa se rechaza campo por campo, con el motivo.

**`verify(text, memory_ids)`** devuelve las cifras del texto que no aparecen en esas
memorias, con la misma comparación. **No comprueba unidades.**

## 7. Recuperación

**Modo hecho:** `facts_query({type, identity?, at?, history?})` devuelve filas con `status`
`current`, `expired`, `superseded` o `conflict`.

**Modo contexto:** `memory_retrieve` busca sobre los trozos de forma híbrida.

- **Filtro estructurado primero:** dominio y rango de fechas.
- **Léxico:** configuración `dm_simple` (`simple` + `unaccent`), sin stemming. Los términos de
  4 caracteres o más se buscan por prefijo (`vence:*`). Se busca con OR y **se rankea solo con
  los términos raros**: el umbral es relativo al término más raro de la propia pregunta.
- **Vectores**, si el carril de embeddings está. El modelo es multilingüe a propósito: cruza
  idiomas sin que la memoria sepa ninguno. Las dos listas se fusionan normalizando cada una
  contra su máximo.
- `terms[]` le permite al agente sumar variantes. Es opcional.

**Cambiar de modelo de embeddings lo resuelve la memoria sola.** Cada combinación de modelo y
dimensión es una fila de `embedding_spaces` (`building | active | retired`). El worker
compara lo que el carril declara (`GET /info`) con el espacio activo. Si difiere, construye
uno nuevo en segundo plano y, cuando está completo, lo activa de forma atómica. Mientras
tanto la búsqueda es léxica y lo informa (`vector: "rebuilding"`). **Los espacios nunca se
mezclan.**

## 8. Arquitectura y despliegue

```
Persona ─► Agente (Hermes · OpenClaw) ─► su LLM
                │ MCP (HTTP streamable · stdio)
                ▼
   deizmem: mcp · cli │ core │ worker (jobs en Postgres)
                ▼                  ▼
   Postgres 17 + pgvector    blobs en disco (sha256)
                ▲
   carriles opcionales por URL: documents · ocr · whisper · embed
```

- **Un monolito**, un solo artefacto. `dm mcp`, `dm worker` y el CLI son el mismo binario.
- **Los blobs van a disco**, en `blobs/<aa>/<bb>/<sha256>`, detrás del puerto `BlobStore`.
  Pasar a S3 es cambiar de adapter.
- **La cola es una tabla** (`jobs`, con `for update skip locked`). Sin Redis ni pg-boss.
- **Los carriles** se activan con una variable `DM_*_URL`. Uno ausente aparece como `off` en
  `dm doctor`. Texto plano, Markdown y CSV se leen inline, sin carril.
- **Todo se construye en el Pi, para arm64.** El código se edita en el Mac, se sincroniza
  (`scripts/pi.sh`) y se levanta con compose en `~/Dev/deizmem` del Pi.

## 9. Identidad

Sin cuentas ni contraseñas. `dm pair --mcp` acuña un código de 15 minutos. `dm token <code>`
lo canjea por un token con expiración y revocación, y el agente lo usa como `Bearer`. Un
agente que atiende a varias personas necesita un token por persona. El CLI elige el dueño con
`--actor`, o toma el único que exista.

## 10. Reglas duras

**Código** significa que la memoria lo garantiza. **Contrato** significa que lo cumple el
agente, siguiendo el `SKILL.md`.

1. Todo dato factual va con su `memory_id`. Código en lo que se devuelve; contrato en la prosa.
2. Ninguna cifra que no esté en lo leído. Código en la evidencia y en `verify`; contrato en
   usarlos.
3. Si hay un conflicto, se muestran los dos. Código en marcarlo; contrato en mostrarlo.
4. Nunca bloquear una captura con preguntas. Contrato.
5. Salud: devolver lo guardado, nunca interpretar. Contrato.
6. Tributario: mostrar el comprobante, nunca calcular. Contrato.
7. Crear, archivar o fusionar una categoría o un tipo exige `confirm: true`. Código, y la
   persona tiene que haber dicho que sí. Contrato.
8. Lo irreversible se confirma, y `purge` no existe en MCP. Código.
9. Toda consulta se filtra por dueño, y el actor sale del token, nunca de un parámetro.
   Código.
10. Si un dato está vencido o superado, se dice antes del dato. Código en marcarlo; contrato
    en decirlo primero.

## 11. Estado

Se construye por tajadas, y cada una se prueba en el Pi antes de pasar a la siguiente:

- [x] **S0** Esqueleto: compose, migraciones, `dm init`, `dm doctor`, sincronización al Pi
- [x] **S1** Capturar, leer (inline y markitdown), trocear, buscar, `needs_text`
- [x] **S2** MCP (HTTP y stdio), tokens, cola de trabajo
- [x] **S3** Dominios, clasificar, tipos, hechos con evidencia, `facts_query`, `verify`
- [ ] **S4** Carril de embeddings (ONNX multilingüe) y reindexación automática
- [ ] **S5** Carriles OCR y Whisper
- [ ] **S6** Conectado a Hermes, con el `SKILL.md`

## 12. Cómo se trabaja

- `npm test`: unit e integración contra un Postgres en Docker local.
- `scripts/pi.sh up`: rsync al Pi, más `docker compose up -d --build`.
- `scripts/pi.sh dm <args>`: corre el CLI dentro del contenedor del Pi.
- En el Pi: SD con poco espacio. Antes de sumar una imagen, `docker system df`.
- Commits pequeños por tajada. No se pushea a ningún remoto sin preguntar.
