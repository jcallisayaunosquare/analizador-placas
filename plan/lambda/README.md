# `plateRecognizer` — scaffold ejecutable

Implementacion de referencia de la **opcion (b)**: Lambda Node.js 24 / arm64, zip, que
lee un fotograma de S3, lo pasa por Rekognition `DetectText`, normaliza y puntua los
candidatos con las reglas bolivianas y escribe un evento `PlateRecognized` en
`pacs-events`.

Es **autocontenido**: nada de este directorio toca
`D:\Unosquare\Promotion\code`. Cuando el modulo se integre, los archivos se mueven a
`apps/api/src/modules/plates/` y `apps/api/src/main/plate-recognizer.ts`, y
`src/domain/plate.ts` **se borra** para importar `normalizePlate` del anillo de
`residents` (ver la nota en la cabecera de ese archivo).

---

## Correr sin AWS

```bash
cd D:/Unosquare/analizador-placas/plan/lambda
pnpm install
pnpm test        # 30 casos de tabla sobre el anillo domain: sin red, sin credenciales
pnpm typecheck   # TypeScript strict, los mismos flags que apps/api
pnpm offline     # el pipeline completo contra 7 fotogramas guionados + replay
pnpm build       # bundle de esbuild: 11.1 kB. El limite del zip de Lambda son 250 MB.
```

`pnpm offline` imprime, por fotograma, la decision que tomaria el porton:

```
  PASS   1. clean plate, broad daylight
         outcome    published
         plate      1234ABC
         fused      0.902
         decision   ALLOW  .  EXACT_MATCH

  PASS   2. B read as 8, the fuzzy tier earning its keep
         outcome    published
         plate      1234ABC
         fused      0.809
         decision   REVIEW  .  LOW_CONFIDENCE

  PASS   3. signage only, no vehicle in frame
         outcome    published
         plate      -
         fused      0.000
         decision   no event  .  UNREADABLE
   ...
  PASS  replay of CAP000 -> skipped
        events stored: 7 (7 frames, 1 replay, no duplicate)

  8/8 checks passed
```

Cada fotograma declara la decision que debe producir, asi que esto tambien es una prueba
de integracion: si una regla cambia, el proceso sale con codigo 1.

El caso 3 es el que importa mirar: un fotograma con `PARQUEO PRIVADO` leido al 99.1% de
confianza **no** produce un evento de acceso. La lista negra de escena y el scoring por
formato son lo que lo evita — y ese caso encontro un bug real durante la construccion:
`VISITAS` se canonicaliza como `V1S1TAS` (I→1), y la expansion del par U/V la convertia
en `U1S1TAS`, una cadena que la lista negra no conocia y que puntuaba como una placa de
7 caracteres. Por eso la lista negra se evalua sobre la **linea**, antes de expandir
variantes. Hay un test de regresion para eso.

## Correr contra Rekognition de verdad

Esta es la prueba que conviene hacer **antes** de escribir infraestructura: responde si
Rekognition sabe leer las placas de las camaras de este edificio.

```bash
# Con una foto local: la sube y la procesa.
pnpm live -- --profile hotel --region us-east-2 \
             --bucket pacs-captures-dev --file ./plate.jpg

# Con un objeto que ya esta en S3.
pnpm live -- --profile hotel --region us-east-2 \
             --bucket pacs-captures-dev \
             --key raw/gate-north/2026/10/09/TEST01.jpg
```

En modo live el **publisher sigue siendo falso**: nada se escribe en `pacs-events`. Lo
unico real son `HeadObject` y `DetectText`.

Permisos necesarios en el perfil: `s3:PutObject` y `s3:GetObject` sobre
`pacs-captures-dev/raw/*`, y `rekognition:DetectText`.

## Estructura

```
src/
├─ domain/                  TypeScript puro. Sin async, sin I/O, sin process.env.
│  ├─ plate.ts              normalizePlate — copia temporal del anillo de residents
│  ├─ bolivian-format.ts    formatos bolivianos, scoring de candidatos, lista negra
│  ├─ fuzzy.ts              confusables no plegados, Damerau-Levenshtein, variantes
│  ├─ quality.ts            score de calidad del recorte (proxy geometrico, documentado)
│  └─ decision.ts           ranking, fusion de confianza y la tabla de decision completa
├─ ports.ts                 el anillo application: PlateRecognizer y los demas puertos
├─ infrastructure/
│  ├─ rekognition-recognizer.ts   la unica clase que sabe de Rekognition
│  └─ aws-adapters.ts             S3 HeadObject + publisher DynamoDB + logger
├─ recognize-capture.ts     el caso de uso: puertos entran, evento sale
└─ handler.ts               composition root + entrypoint de Lambda
test/domain.test.ts         30 casos de tabla sobre todo el anillo domain
scripts/local-test.ts       el driver de las dos secciones de arriba
```

Las dependencias de fuente apuntan solo hacia adentro, igual que los otros cinco modulos
de `apps/api`. `domain/` no importa nada de `infrastructure/`, y `recognize-capture.ts`
no importa ningun SDK de AWS — por eso los 30 tests corren en 210 ms y sin nube.

## Lo que este scaffold NO hace, y por que

| Falta | Razon |
|---|---|
| Escribir en `plate_read` / `access_event` | Esta funcion vive **fuera** de la VPC y no tiene ruta a `hotel-db` (no hay NAT gateway, ADR-016). Lo hace `plateIngest`, el consumidor del stream que si esta dentro de la VPC. |
| La decision final de acceso | Necesita el padron de vehiculos, que esta en Postgres. `decide()` es puro y se llama desde `plateIngest` con las filas cargadas. Aqui solo se calcula un *preview* con padron vacio, que va al log y responde la unica pregunta contestable desde afuera: se leyo una placa. |
| Score de calidad por varianza del Laplaciano | Requiere decodificar el JPEG, es decir `sharp`: un binario nativo, matriz de build arm64 y ~30 MB en el bundle. `domain/quality.ts` usa un proxy geometrico y lo declara. Si la medicion de campo dice que la calidad es la senal limitante, ese es el momento en que la opcion (a) deja de ser un lastre. |
| Recorte de la placa a `crops/` | Mismo motivo: necesita un decodificador. El recorte se puede generar en el navegador del administrador a partir del fotograma y la bbox del candidato, que ya viaja en el evento. |
| Cooldown contra DynamoDB | El puerto `CooldownStore` esta definido; el adaptador vive del lado de `plateIngest`, donde se consulta junto con el padron en la misma invocacion. |

## Despues

El bloque de `serverless.yml`, los statements de IAM, el bucket con su ciclo de vida, el
costo por mil lecturas y la prueba de punta a punta desde shell estan en
[`../DESPLIEGUE-LAMBDA.md`](../DESPLIEGUE-LAMBDA.md). El diseno del modulo y el DDL estan
en [`../MODULO-PLACAS.md`](../MODULO-PLACAS.md). El analisis del repositorio que origino
todo esto, con el veredicto de licencia, esta en
[`../ANALISIS-CARVISION.md`](../ANALISIS-CARVISION.md).
