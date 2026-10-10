# Modulo `plates` — reconocimiento de placas y eventos de acceso

Diseno del nuevo modulo de PACS. Se apoya en lo que ya existe y no lo reescribe:

- `vehicle` ya es el registro de placas de los residentes (migracion
  `1759600003000_vehicle-register.ts`).
- `src/modules/residents/domain/vehicle.ts` ya define la forma canonica
  (`normalizePlate`) y deja dicho por escrito que **el match difuso pertenece a este
  modulo**, porque es aqui donde existe un score de confianza. Este documento cumple esa
  promesa.
- El patron "funcion fuera de la VPC + tabla de eventos DynamoDB + stream" ya se usa para
  el aprovisionamiento en Cognito. El reconocedor reutiliza exactamente ese camino.

---

## 1. Flujo de captura

```
 [1] Camara en el porton detecta movimiento
        |  captura 3-5 fotogramas del vehiculo en marcha
        v
 [2] PUT presignado a S3   pacs-captures-<stage>/raw/<cameraId>/<yyyy>/<mm>/<dd>/<captureId>.jpg
        |  metadata: x-amz-meta-camera-id, x-amz-meta-captured-at, x-amz-meta-capture-id
        v
 [3] S3:ObjectCreated:Put  --(filtro prefix=raw/, suffix=.jpg)-->  Lambda `plateRecognizer`
        |                                                           (FUERA de la VPC)
        |  3a. HeadObject: lee metadata, valida tamano y tipo
        |  3b. reconocimiento (puerto PlateRecognizer -> Rekognition DetectText)
        |  3c. normalizacion + scoring por formato boliviano
        |  3d. PutItem en `pacs-events-<stage>`:  pk = plateread#<captureId>
        v
 [4] DynamoDB Stream  -->  Lambda `integrations`  (ya existe, fuera de la VPC)
        |  no toca la base; solo reenvia. Nada cambia aqui.
        v
 [4'] El camino real a Postgres: `plateRecognizer` escribe el evento y el
      consumidor IN-VPC lo aplica. Ver 1.1.
        v
 [5] `plates` (dentro del lambdalith `api`, en la VPC)
        |  5a. INSERT en plate_read  (idempotente por capture_id)
        |  5b. match contra vehicle.plate  -> exacta | difusa | sin match
        |  5c. decision  -> INSERT en access_event (ALLOW / DENY / REVIEW)
        |  5d. outbox: AccessGranted | AccessDenied | PlateReadNeedsReview
        v
 [6] `integrations` consume el outbox: notificacion al residente / al administrador
```

### 1.1 Por que el reconocedor no escribe en Postgres

La misma restriccion de siempre (ADR-016): **no hay NAT gateway**. Una funcion dentro de
la VPC no alcanza Rekognition ni S3 por HTTPS; una funcion fuera de la VPC no alcanza
`hotel-db`. Hay tres salidas y elegimos la tercera:

| Opcion | Por que no / si |
|---|---|
| Endpoint de interfaz para Rekognition + S3 desde la VPC | Funciona, pero un endpoint de interfaz cuesta ~USD 7.30 por AZ al mes. Con tres subredes son ~22 USD/mes, mas que el costo de inferencia completo del edificio. Y S3 ya tiene endpoint **gateway** gratuito. |
| NAT gateway | ~32 USD/mes de base. Es exactamente lo que ADR-016 evito. |
| **Dos funciones, una tabla de eventos entre ellas** | **Elegida.** `plateRecognizer` vive fuera de la VPC (ve S3 y Rekognition), escribe en `pacs-events`. Un consumidor del stream dentro de la VPC —una funcion nueva, `plateIngest`— lee el evento y lo aplica a Postgres con IAM auth. Es el patron ya probado del flujo Cognito, invertido. |

`plateIngest` necesita el endpoint **gateway** de DynamoDB que ya existe
(`DynamoDbEndpoint` en `serverless.yml`) para hacer `PutItem` de su outbox, pero **el
stream lo invoca el servicio Lambda**, no la funcion: una funcion in-VPC puede ser
disparada por un stream de DynamoDB sin ruta de salida. Esto ya se demostro en este
proyecto con `sweeper`.

### 1.2 Contrato del evento `plateread`

```jsonc
{
  "pk": "plateread#01JB3K5Z9Q7M2N4P6R8T0V2X4Y",   // captureId, ULID
  "type": "PlateRecognized",
  "captureId": "01JB3K5Z9Q7M2N4P6R8T0V2X4Y",
  "cameraId": "gate-north",
  "capturedAt": "2026-10-09T14:03:11.482Z",
  "objectKey": "raw/gate-north/2026/10/09/01JB3K....jpg",
  "candidates": [
    { "plate": "1234ABC", "raw": "1234 ABC", "confidence": 0.942, "score": 168.4,
      "box": { "left": 0.41, "top": 0.62, "width": 0.17, "height": 0.05 } },
    { "plate": "1Z34ABC", "raw": "1234 ABC", "confidence": 0.942, "score": 88.4 }
  ],
  "best": { "plate": "1234ABC", "confidence": 0.942 },
  "quality": 0.71,
  "engine": "rekognition-detect-text",
  "engineVersion": "2026-10",
  "latencyMs": 611,
  "expiresAt": 1791640991        // TTL 14 dias; el registro durable vive en Postgres
}
```

`candidates` va ordenado por `score` descendente, maximo 8. `best` es `candidates[0]`
solo si su score supera el minimo; si no, `best` es `null` y la lectura nace en estado
`REVIEW`.

---

## 2. Modelo de datos

Dos tablas nuevas. `vehicle` no se toca.

```sql
-- ============================================================= enums
CREATE TYPE plate_read_status AS ENUM ('MATCHED', 'UNMATCHED', 'REVIEW', 'DISCARDED');
CREATE TYPE plate_match_kind  AS ENUM ('EXACT', 'FUZZY', 'MANUAL', 'NONE');
CREATE TYPE access_decision   AS ENUM ('ALLOW', 'DENY', 'REVIEW');

-- ======================================================== plate_read
-- Una fila por captura. Es el registro de lo que la camara leyo, no de lo que
-- decidimos: la decision vive en access_event. Separarlos permite corregir una
-- lectura sin reescribir el historial de accesos, que debe ser inmutable.
CREATE TABLE plate_read (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- La clave de idempotencia. La genera el cliente de captura (ULID) y viaja en la
  -- metadata del objeto S3. UNIQUE, no "intentamos no duplicar": un reintento de S3,
  -- un reproceso del stream o un redeploy del consumidor llegan al mismo INSERT.
  capture_id      varchar(40) NOT NULL UNIQUE,

  camera_id       varchar(64) NOT NULL,
  captured_at     timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),

  -- Lo que el OCR leyo, sin tocar. Para auditoria y para reentrenar un umbral.
  raw_text        varchar(64),
  -- La forma canonica, por la MISMA funcion normalizePlate() que escribe vehicle.plate.
  -- Sin esto, "ya registrada" y "reconocida en el porton" podrian discrepar.
  plate           varchar(20),
  CONSTRAINT ck_plate_read_canonical
    CHECK (plate IS NULL OR plate ~ '^[A-Z0-9]{2,20}$'),

  confidence      numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  -- El score de nitidez/contraste del recorte. Senal independiente de la confianza
  -- del OCR: un recorte borroso con OCR seguro de si mismo es la lectura peligrosa.
  quality         numeric(5,4) CHECK (quality IS NULL OR quality BETWEEN 0 AND 1),

  status          plate_read_status NOT NULL,
  -- El vehiculo con el que empato, si empato. ON DELETE SET NULL, no CASCADE: una
  -- lectura es evidencia y sobrevive a que el residente borre el auto.
  vehicle_id      uuid REFERENCES vehicle (id) ON DELETE SET NULL,
  match_kind      plate_match_kind NOT NULL DEFAULT 'NONE',
  -- Distancia de edicion al plate del vehiculo empatado. 0 en EXACT.
  match_distance  smallint CHECK (match_distance IS NULL OR match_distance BETWEEN 0 AND 4),

  -- Candidatos completos tal como los emitio el motor. jsonb y no tablas: nunca se
  -- consulta por su contenido, solo se muestra en la pantalla de revision.
  candidates      jsonb NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT ck_plate_read_candidates_array CHECK (jsonb_typeof(candidates) = 'array'),

  image_key       varchar(512) NOT NULL,       -- objeto S3 del fotograma
  crop_key        varchar(512),                -- recorte de la placa, si se guardo
  engine          varchar(40)  NOT NULL,
  engine_version  varchar(40),
  latency_ms      integer CHECK (latency_ms IS NULL OR latency_ms >= 0),

  -- Revision humana. NULL mientras nadie la haya tocado.
  reviewed_by     uuid REFERENCES resident (id) ON DELETE SET NULL,
  reviewed_at     timestamptz,
  review_note     text,
  -- La placa que el administrador afirmo que era. Alimenta el conjunto de evaluacion.
  corrected_plate varchar(20),
  CONSTRAINT ck_plate_read_corrected_canonical
    CHECK (corrected_plate IS NULL OR corrected_plate ~ '^[A-Z0-9]{2,20}$'),
  CONSTRAINT ck_plate_read_review_complete
    CHECK ((reviewed_at IS NULL) = (reviewed_by IS NULL))
);

-- La consulta de la cola de revision: lo pendiente, lo mas viejo primero.
CREATE INDEX ix_plate_read_review_queue
  ON plate_read (captured_at) WHERE status = 'REVIEW' AND reviewed_at IS NULL;
-- "cuando entro este auto": historial por placa.
CREATE INDEX ix_plate_read_plate_time ON plate_read (plate, captured_at DESC)
  WHERE plate IS NOT NULL;
-- El panel por camara y la ventana de dedupe.
CREATE INDEX ix_plate_read_camera_time ON plate_read (camera_id, captured_at DESC);
CREATE INDEX ix_plate_read_vehicle ON plate_read (vehicle_id) WHERE vehicle_id IS NOT NULL;

-- ====================================================== access_event
-- La bitacora de acceso. Append-only por la misma razon que allocation_history
-- (BR-05): es el registro al que se recurre cuando alguien discute quien entro.
CREATE TABLE access_event (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plate_read_id  uuid NOT NULL REFERENCES plate_read (id) ON DELETE RESTRICT,
  -- Desnormalizado a proposito: el residente puede dar de baja el vehiculo y la
  -- bitacora debe seguir diciendo que placa entro.
  plate          varchar(20) NOT NULL,
  vehicle_id     uuid REFERENCES vehicle (id) ON DELETE SET NULL,
  resident_id    uuid REFERENCES resident (id) ON DELETE SET NULL,
  -- El cajon asignado al residente en el ciclo vigente, si tenia uno. Util para la
  -- pregunta real del administrador: entro un auto autorizado a un cajon que no es suyo.
  spot_id        uuid REFERENCES parking_spot (id) ON DELETE SET NULL,

  decision       access_decision NOT NULL,
  -- Codigo estable, legible y traducible en el frontend. No prosa.
  reason         varchar(48) NOT NULL,
  camera_id      varchar(64) NOT NULL,
  occurred_at    timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),

  -- Si un administrador revirtio la decision, aqui esta la nueva fila y aqui el enlace.
  -- La fila original nunca se modifica.
  superseded_by  uuid REFERENCES access_event (id) ON DELETE SET NULL,

  -- Una decision por lectura, salvo que sea una correccion explicita.
  CONSTRAINT ux_access_event_one_per_read UNIQUE (plate_read_id, superseded_by)
);

CREATE INDEX ix_access_event_time ON access_event (occurred_at DESC);
CREATE INDEX ix_access_event_resident ON access_event (resident_id, occurred_at DESC)
  WHERE resident_id IS NOT NULL;
CREATE INDEX ix_access_event_denied ON access_event (occurred_at DESC)
  WHERE decision = 'DENY';

-- Como allocation_history: app_user puede leer e insertar, nunca modificar ni borrar.
GRANT SELECT, INSERT, UPDATE ON plate_read   TO app_user;   -- UPDATE solo para la revision
GRANT SELECT, INSERT         ON access_event TO app_user;
```

### 2.1 Como se une al registro de los residentes

```sql
-- El join del porton: una lectura -> el auto -> el residente -> su cajon vigente.
SELECT v.id            AS vehicle_id,
       v.resident_id,
       r.full_name,
       r.is_eligible,
       sa.spot_id
  FROM vehicle v
  JOIN resident r ON r.id = v.resident_id
  LEFT JOIN spot_assignment sa
         ON sa.resident_id = r.id
        AND sa.status = 'ACTIVE'
 WHERE v.plate = $1          -- $1 = normalizePlate(lectura)
   AND v.is_active;          -- usa ux_vehicle_plate_active
```

El indice `ux_vehicle_plate_active ON vehicle (plate) WHERE is_active` existe ya y es
exactamente el que esta consulta necesita. El match exacto es una busqueda por indice
unico: sub-milisegundo.

Para el match difuso hace falta una segunda via, porque no se puede indexar la distancia
de edicion. Dos pasos:

```sql
-- Paso 1: reducir el universo por longitud y por el multiconjunto de caracteres.
--         Un edificio tiene decenas, no millones, de vehiculos; esto ya basta.
SELECT id, resident_id, plate FROM vehicle
 WHERE is_active AND length(plate) BETWEEN length($1) - 1 AND length($1) + 1;
-- Paso 2: la distancia se calcula en el dominio (TypeScript puro, testeable sin base).
```

Si el padron llegara a crecer, la via indexable es `pg_trgm`:
`CREATE EXTENSION pg_trgm; CREATE INDEX ix_vehicle_plate_trgm ON vehicle USING gin (plate gin_trgm_ops);`
y `WHERE plate % $1 ORDER BY plate <-> $1 LIMIT 5`. No se incluye en la primera
migracion porque requiere una extension y el paso 1 resuelve el caso real.

---

## 3. Endpoints

Siguiendo el contrato existente: todo menos `GET /health` lleva bearer token, los `{id}`
son UUID validados antes de llegar a una consulta, y los errores usan la forma unica con
`traceId`.

| Metodo y ruta | Rol | Proposito |
|---|---|---|
| `POST /captures` | `CAMERA` | Pide un PUT presignado a S3. Cuerpo: `{ cameraId, capturedAt, contentType }`. Devuelve `{ captureId, uploadUrl, expiresIn: 300 }`. El reconocimiento lo dispara S3, no esta llamada. |
| `GET /plate-reads` | admin | Lista paginada. Filtros `?status=`, `?cameraId=`, `?plate=`, `?from=`, `?to=`, `?cursor=`. |
| `GET /plate-reads/{id}` | admin | Detalle: candidatos, URL presignada de lectura del fotograma y del recorte (5 min), decision asociada. |
| `GET /plate-reads/review` | admin | La cola de revision. Orden: `captured_at` ascendente — lo mas viejo primero, porque una lectura dudosa pierde valor cuando el auto ya se fue. |
| `POST /plate-reads/{id}/resolve` | admin | UC de revision. Cuerpo: `{ plate?, vehicleId?, decision: 'ALLOW'\|'DENY', note? }`. Requiere `Idempotency-Key`. |
| `GET /access-events` | admin | Bitacora. Filtros `?decision=`, `?residentId=`, `?from=`, `?to=`, `?format=csv`. |
| `GET /me/access-events` | cualquiera | Los propios accesos del residente. Solo los suyos, derivados del token. |
| `GET /metrics/plates` | admin | Tasa de match, distribucion de confianza, tamano y antiguedad de la cola, lecturas por camara. |

Nada en esta lista hace reconocimiento sincronico. Un `POST /plate-reads` que corra OCR
seria una API que tarda 600 ms y se cae con la camara; el camino es siempre S3 → evento.

### 3.1 Rol `CAMERA`

Un tercer grupo en el user pool de Cognito, junto a `ADMIN` y `RESIDENT`. Un cliente de
camara es una maquina: se le crea un usuario dedicado por porton, su unico permiso es
`POST /captures`, y la rotacion de su credencial no afecta a ningun residente. Alternativa
descartada: una API key en el header, que no se puede revocar por porton sin un redeploy.

---

## 4. Idempotencia

Tres capas, porque los tres caminos pueden repetirse de forma independiente.

1. **`capture_id` UNIQUE en `plate_read`.** Lo genera el cliente de captura y viaja en la
   metadata de S3. El INSERT es
   `INSERT ... ON CONFLICT (capture_id) DO NOTHING RETURNING id`; si no devuelve fila, la
   captura ya se proceso y el consumidor del stream responde exito sin reprocesar.
   Entregas al-menos-una-vez del stream se vuelven efecto exactamente-una-vez.
2. **`pk = plateread#<captureId>` en `pacs-events`.** Un reintento de S3 sobre el mismo
   objeto sobrescribe el mismo item en lugar de crear uno nuevo. No se gasta una llamada
   a Rekognition de mas: antes de reconocer, el reconocedor hace `GetItem` de esa `pk` y
   si ya existe con el mismo `objectKey` y ETag, sale.
3. **Cooldown de negocio.** La idea que tomamos de CarVision, con el almacen correcto:
   un item en `pacs-cache` con `pk = platecooldown#<cameraId>#<plate>` y TTL de 30 s.
   Si existe, la lectura se guarda con `status = 'DISCARDED'` y **no** genera
   `access_event`. Esto evita 20 filas de bitacora por un solo auto que avanza despacio.
   Importante: se descarta el *evento de acceso*, no la lectura — el fotograma sigue
   siendo evidencia.

El cooldown es por `(camara, placa)` y no global: el mismo auto entrando por el porton
norte y saliendo por el sur son dos hechos distintos.

`POST /plate-reads/{id}/resolve` exige `Idempotency-Key` igual que
`POST /cycles/{id}/runs`, y reutiliza el mismo mecanismo que ya esta implementado.

---

## 5. Umbrales de confianza

Dos numeros y un producto, configurables en `allocation_config` para no necesitar un
deploy para moverlos.

```
fused = confidence_ocr * (0.6 + 0.4 * quality)          // la formula de CarVision
```

| Condicion | `plate_read.status` | `access_event.decision` | `reason` |
|---|---|---|---|
| `fused >= 0.85` y match exacto | `MATCHED` | `ALLOW` | `EXACT_MATCH` |
| `fused >= 0.85` y match difuso con `distance <= 1` y candidato unico | `MATCHED` | `ALLOW` | `FUZZY_MATCH_SINGLE` |
| `fused >= 0.85` y match difuso con mas de un candidato | `REVIEW` | `REVIEW` | `FUZZY_MATCH_AMBIGUOUS` |
| `fused >= 0.85` y sin match | `UNMATCHED` | `DENY` | `PLATE_NOT_REGISTERED` |
| `0.55 <= fused < 0.85` | `REVIEW` | `REVIEW` | `LOW_CONFIDENCE` |
| `fused < 0.55` | `REVIEW` | — (ninguno) | `UNREADABLE` |
| Match exacto pero `resident.is_eligible = false` | `MATCHED` | `DENY` | `RESIDENT_NOT_ELIGIBLE` |
| Match exacto pero `vehicle.is_active = false` | `UNMATCHED` | `DENY` | `VEHICLE_INACTIVE` |
| Cooldown activo | `DISCARDED` | — | `DUPLICATE_WITHIN_COOLDOWN` |

Decisiones que vale la pena justificar:

- **`fused < 0.55` no genera `access_event`.** Una lectura ilegible no es un intento de
  acceso negado; es una camara sucia o un auto muy rapido. Si generara `DENY`, la
  bitacora se llenaria de negaciones que no corresponden a nadie y la metrica de
  negaciones dejaria de significar algo.
- **Un match difuso ambiguo nunca abre.** Si `1234ABC` y `1Z34ABC` estan ambas
  registradas y a distancia 1 de la lectura, abrir seria elegir al azar a quien atribuir
  una entrada. Va a revision.
- **`PLATE_NOT_REGISTERED` es `DENY`, no `REVIEW`.** Una placa leida con alta confianza
  que no esta en el padron es una visita o un intruso: un hecho, no una duda. Si el
  edificio quiere un camino para visitas, es una funcion aparte (placa temporal con
  vencimiento), no un relajamiento del umbral.
- Los umbrales 0.85 y 0.55 son **un punto de partida honesto, no una medicion**. Se
  calibran con el procedimiento de la seccion 8.

---

## 6. Normalizacion y match difuso

### 6.1 Capa canonica — ya existe, no se duplica

`normalizePlate()` en `src/modules/residents/domain/vehicle.ts`: quita diacriticos,
descarta todo lo que no sea `[0-9A-Za-z]`, mayusculiza y pliega **solo** `O→0`, `Q→0`,
`I→1`. Es la clave de `vehicle.plate` y del indice unico. El modulo `plates` **importa
esta funcion**; no escribe su propia version. Si hubiera dos definiciones, "ya registrada"
y "reconocida en el porton" podrian discrepar, que es exactamente lo que el comentario de
ese archivo advierte.

Espacios, guiones y puntos desaparecen aqui: `"1234 ABC"`, `"1234-ABC"` y `"1234.ABC"`
colapsan todos a `1234ABC`.

### 6.2 Capa difusa — nueva, y solo aqui

Los pares que el registro deliberadamente **no** pliega (porque plegarlos causaria
colisiones falsas en una clave unica) si se consideran aqui, donde hay un score y una
cola de revision detras:

```
S <-> 5     B <-> 8     Z <-> 2     G <-> 6     D <-> 0
T <-> 7     A <-> 4     E <-> F     U <-> V     M <-> N
```

El algoritmo, en tres pasos, todo en el anillo `domain/` (TypeScript puro, sin I/O):

1. **Expansion de confusables.** Por cada posicion, sustituir el caracter por su par y
   generar la variante. Se genera hasta **una sola sustitucion a la vez** mas la variante
   "todas las letras ambiguas a digito", igual que hace CarVision. Con 7 caracteres son
   ~8 variantes, no 2^7: la explosion combinatoria no aporta y multiplica el costo.
2. **Scoring por formato boliviano.** Sobre cada variante:

   | Patron | Que es | Bonus |
   |---|---|---|
   | `^\d{4}[A-Z]{3}$` | Placa unica vigente (desde 2010), p. ej. `1234ABC` | +100 |
   | `^\d{3}[A-Z]{3}$` | Placa unica de serie corta, p. ej. `123ABC` | +80 |
   | `^\d{3,4}[A-Z]{2}$` | Motocicleta | +60 |
   | `^[A-Z]{3}\d{3}$` | Formato antiguo anterior a la placa unica | +40 |
   | `^\d{3,4}[A-Z]{3}\d$` | Con digito verificador leido | +30 |
   | cualquier otro | — | 0 |

   Mas la base de CarVision: `confianza * 100`, `+2` por caracter, `+20` si tiene
   digitos, `-200` si no tiene ninguno, `-500` si la longitud sale de `[5, 8]`.

   > Los formatos estan tomados de la placa unica boliviana y de las series anteriores.
   > **Hay que confirmarlos contra el padron real del edificio antes de calibrar**, y la
   > tabla vive en configuracion (`allocation_config`), no en el codigo compilado, para
   > que agregar un formato sea un `UPDATE`.

3. **Lista negra de escena.** Descartar candidatos que sean palabras que una camara de
   porton lee de verdad: `PARQUEO`, `PRIVADO`, `VISITAS`, `SALIDA`, `ENTRADA`, `RESERVADO`,
   `BOLIVIA`, `LAPAZ`, `SANTACRUZ`, `COCHABAMBA`, `PROHIBIDO`, `ESTACIONAR`, `TAXI`.
   La idea es de CarVision; la lista es nuestra y tambien va en configuracion.

4. **Distancia y decision.** Para el mejor candidato, distancia de Damerau-Levenshtein
   contra las placas activas de longitud +/-1. Damerau y no Levenshtein simple porque la
   transposicion (`1243ABC` por `1234ABC`) es un error de lectura comun y Levenshtein la
   cobra como 2. Se aplica la tabla de la seccion 5.

### 6.3 Ejemplos trabajados

| Leido por el OCR | `normalizePlate` | Mejor variante difusa | Resultado |
|---|---|---|---|
| `1234 ABC` | `1234ABC` | — | `EXACT_MATCH` si `1234ABC` esta registrada |
| `l234-A8C` | `1234A8C` | `1234ABC` (B↔8) | `FUZZY_MATCH_SINGLE`, distancia 1 |
| `O123ABC` | `0123ABC` | — | `EXACT_MATCH` contra `O123ABC` registrada: el registro guardo `0123ABC` |
| `1Z34ABC` | `1Z34ABC` | `1234ABC` (Z↔2) | `FUZZY_MATCH_SINGLE` si solo `1234ABC` empata |
| `PARQUEO` | `PARQUE0` | — | descartado por lista negra → `UNREADABLE` |
| `5678AB` | `5678AB` | `5678AB` | formato moto, +60; si no esta registrada, `DENY` |

---

## 7. Como revisa el administrador una lectura dudosa

La pantalla (`/admin/plate-reads` en `apps/web`, lazy como las otras seis) muestra la
cola de `GET /plate-reads/review` y, por fila:

1. **El fotograma** y el recorte de la placa, con URLs presignadas de 5 minutos. No se
   sirven imagenes desde la API.
2. **Lo que el motor leyo**: `raw_text`, la forma canonica, `confidence`, `quality` y el
   `fused` ya calculado. Que vea los tres numeros, no solo el producto.
3. **Los candidatos** con su score, cada uno como un boton de un clic.
4. **Los vehiculos cercanos**: las placas activas a distancia <= 2, con el nombre del
   residente. Normalmente el administrador reconoce el auto antes de leer la placa.
5. **Tres acciones**, todas via `POST /plate-reads/{id}/resolve`:
   - *Es esta placa* → `{ plate, vehicleId, decision: 'ALLOW' }`.
   - *No esta registrada* → `{ decision: 'DENY' }`.
   - *Ilegible, descartar* → `{ decision: 'DENY', note }`, y la lectura pasa a
     `DISCARDED` sin generar `access_event`.

Lo que pasa al resolver, en **una transaccion**:

```
UPDATE plate_read SET status, plate, corrected_plate, vehicle_id,
                      match_kind = 'MANUAL', reviewed_by, reviewed_at, review_note
 WHERE id = $1 AND reviewed_at IS NULL        -- el guardia contra dos admins a la vez
INSERT INTO access_event (...)                 -- fila nueva
UPDATE access_event SET superseded_by = <nueva> WHERE id = <la previa de REVIEW>
INSERT INTO event_outbox (...)                 -- AccessReviewResolved
```

`WHERE reviewed_at IS NULL` es el bloqueo real: si dos administradores abren la misma
fila, el segundo recibe `409 PLATE_READ_ALREADY_REVIEWED` y la pantalla se recarga. Es el
mismo tipo de guardia que el indice parcial del sorteo (guardia 1 de §12): la base decide,
no la aplicacion.

### 7.1 Lo que la revision deja atras

Cada `corrected_plate` es **una etiqueta de verdad**. Despues de 200 revisiones existe un
conjunto de evaluacion real, con las imagenes en S3 y la respuesta correcta en Postgres,
que permite decir "el motor acierta el X% de las lecturas que llegan". Esa es la cifra
que CarVision no tiene y que decide si vale cambiar de motor. El modulo guarda el material
para medirse desde el primer dia, no como una fase posterior.

---

## 8. Calibracion de umbrales

Los 0.85/0.55 se mueven con datos, no con opiniones:

1. Semana 1 en sombra: `plates` registra y decide, pero el porton no se acciona por
   software; el portero sigue abriendo. Todo entra en `plate_read`.
2. Se revisan 200 lecturas distribuidas en todo el rango de `fused`, no solo las dudosas.
3. Con `corrected_plate` se construye la curva de precision por umbral y se elige el
   punto donde el falso-ALLOW es cero y el volumen de revision es tolerable (meta: menos
   del 10% de las lecturas).
4. `UPDATE allocation_config`. Sin deploy.

Si en el paso 3 no existe un umbral con falso-ALLOW cero y menos del 15% de revision, el
motor no sirve para este edificio y se cambia el adaptador — ver
`DESPLIEGUE-LAMBDA.md`, seccion de migracion de motor. Esa es la razon de que el
reconocimiento este detras de un puerto.

---

## 9. Anillos del modulo

Misma estructura que los otros cinco modulos. Las dependencias de fuente apuntan solo
hacia adentro.

```
src/modules/plates/
├─ domain/                        TypeScript puro, sin async, sin I/O
│  ├─ plate-candidate.ts          Candidate, fuseConfidence(), rankCandidates()
│  ├─ plate-fuzzy.ts              confusables, Damerau-Levenshtein, expandVariants()
│  ├─ bolivian-format.ts          la tabla de patrones y su scoring
│  ├─ access-decision.ts          la tabla de la seccion 5, como funcion pura
│  └─ plate-read.ts               PlateRead, AccessEvent, invariantes
├─ application/                   solo puertos
│  ├─ ports.ts                    PlateReadRepository, AccessEventRepository,
│  │                              VehicleLookup, CooldownStore, CaptureStorage,
│  │                              PlateRecognizer   <-- el puerto que se cambia
│  ├─ ingest-plate-read.ts        UC: evento -> plate_read + access_event + outbox
│  ├─ resolve-plate-read.ts       UC: revision del administrador
│  └─ list-plate-reads.ts         UC: cola y bitacora
└─ infrastructure/                Kysely, DynamoDB, S3, Rekognition
   ├─ plate-read.repository.ts
   ├─ access-event.repository.ts
   ├─ vehicle-lookup.repository.ts
   ├─ dynamo-cooldown.store.ts
   ├─ s3-capture.storage.ts
   └─ rekognition.recognizer.ts   la unica clase que sabe de Rekognition
```

`access-decision.ts` es puro a proposito: la tabla de umbrales de la seccion 5 se prueba
con 30 casos de tabla y sin tocar AWS, igual que el sorteo se prueba 10 000 veces sin
tocar la nube. Es el mismo argumento que hace testeable el resto de este backend.

El puerto `PlateRecognizer` es una interfaz de un metodo:

```ts
export interface PlateRecognizer {
  recognize(input: { bucket: string; key: string }): Promise<RecognitionResult>;
}
export interface RecognitionResult {
  readonly candidates: readonly RawCandidate[];
  readonly quality: number | null;
  readonly engine: string;
  readonly engineVersion: string | null;
  readonly latencyMs: number;
}
```

Cambiar de Rekognition a un contenedor Python o a una API externa es escribir una clase
mas en `infrastructure/` y una linea en el composition root de `src/main`. Nada del
dominio, de la base ni de la API cambia.
