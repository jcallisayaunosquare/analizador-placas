# Despliegue del modulo de placas en AWS — us-east-2

Pasos concretos. Cuenta `309887812390`, perfil `hotel`, region **us-east-2** y solo
us-east-2 (la SCP `p-wvjo6arp` niega todas las demas).

---

## 0. Las tres opciones, comparadas

| | (a) Contenedor Python con el pipeline de CarVision | (b) **Rekognition `DetectText`** | (c) API ALPR externa (Plate Recognizer / OpenALPR Cloud) |
|---|---|---|---|
| Lenguaje | Python 3.12 | **Node.js 24 / TypeScript** — el del monorepo | Node.js 24 / TypeScript |
| Empaquetado | Imagen OCI, ~2.8-3.5 GB (torch + torchvision + opencv + easyocr + pesos) | **Zip de ~1.2 MB** (`@aws-sdk/client-rekognition` + S3) | Zip, ~1 MB |
| Limite de 250 MB del zip | **Imposible.** Solo torch son ~900 MB descomprimidos. Obliga a imagen de contenedor (limite 10 GB) | **Sobra** | Sobra |
| arm64 | Posible: hay ruedas `manylinux_aarch64` para torch, opencv y easyocr, pero la matriz es mas fragil y el build cruzado en Windows necesita `docker buildx` + QEMU (lento) | **Nativo**, igual que las cuatro funciones actuales | Nativo |
| Arranque frio | **8-15 s** medidos tipicamente para importar torch + cargar YOLOv8n + CRAFT. SnapStart no aplica a imagenes de contenedor. Mitigable con provisioned concurrency, que se paga 24x7 | **250-400 ms** | 250-400 ms |
| Latencia caliente | 400-900 ms en 3 GB de memoria (CPU, sin GPU) | 500-800 ms, dominada por la llamada a Rekognition | 700-2000 ms, red a internet incluida |
| Licencia | **AGPL-3.0** via `ultralytics` + `plate.pt`. Servir un backend propietario con eso obliga a publicar el fuente o a comprar la licencia comercial de Ultralytics. Y el codigo de CarVision no tiene LICENSE | **Limpia.** Servicio de AWS, sin obligaciones de copyleft | Limpia, pero sujeta a los terminos del proveedor |
| Precision | La mas alta **si** se reentrena con placas bolivianas. Sin reentrenar, el `plate.pt` publicado solo localiza; el OCR de EasyOCR en placas bolivianas no esta medido por nadie | OCR de escena generico. Bueno con placa grande y bien encuadrada; debil con angulo, noche o placa pequena. Necesita el filtro por patron + la cola de revision | **La mejor sin trabajo propio.** Tienen modelos por region, Bolivia incluida |
| Datos | Nada sale de la cuenta | Nada sale de la cuenta | **La imagen de la placa de un residente sale a un tercero.** Hay que decirlo en el aviso de privacidad del edificio |
| Operacion | ECR, builds de imagen, reentrenamiento, versionado de pesos, un lenguaje mas en el monorepo y en el CI | Una funcion mas en el `serverless.yml` que ya existe | Una funcion mas, mas una clave y un proveedor del que depende el porton |
| Costo / 1000 lecturas | **~0.07 USD** de computo. Mas ~0.15 USD/mes de ECR | **~1.03 USD** | **~20 USD** (Plate Recognizer Cloud: ~50 USD por 2500 lecturas en los planes bajos) |

### Recomendacion: **(b) Rekognition `DetectText`**

Y lo digo sabiendo que es **la opcion mas caro por lectura de las tres en computo**. Las
razones, en orden de peso:

1. **Es la unica que encaja en el stack sin agregar un lenguaje.** El monorepo es pnpm +
   TypeScript estricto, el CI es Node, las cuatro funciones son `nodejs24.x` arm64 y la
   arquitectura limpia esta expresada en TypeScript. Introducir Python con torch agrega
   un segundo toolchain, un segundo gestor de dependencias, un segundo pipeline de build
   de imagen y un segundo conjunto de CVEs que parchear, para un modulo que procesa unos
   cientos de imagenes al dia.
2. **La licencia de (a) no es negociable.** `ultralytics` es AGPL-3.0 y CarVision no tiene
   archivo de licencia. Para una evaluacion de promocion, proponer un despliegue que
   obliga a abrir el codigo del backend del edificio —o a comprar una licencia comercial—
   sin decirlo, es un error de criterio mas grave que pagar 1 USD por mil lecturas.
3. **El costo absoluto es irrelevante a esta escala.** Un edificio residencial genera del
   orden de 300 lecturas al dia: ~9000/mes, **~9.30 USD/mes**. La diferencia con la opcion
   (a) es de unos 8 USD al mes, menos que el endpoint de interfaz que (a) tambien
   necesitaria. No hay nada que optimizar aqui.
4. **El arranque frio decide la experiencia.** El porton no tiene cola: entre que el auto
   frena y que el conductor se impacienta hay ~3 segundos. Una funcion que tarda 12 s en
   el primer frame del dia es una funcion que falla el primer dia. Provisioned concurrency
   lo arregla por ~15 USD/mes, con lo que (a) deja de ser mas barata.
5. **El riesgo de (b) esta acotado por diseno.** Su debilidad es la precision, y el
   modulo ya la trata: umbral de confianza, scoring por formato boliviano, cola de
   revision y un conjunto de evaluacion que se construye solo con cada
   `corrected_plate`. Si la medicion de la semana 1 dice que no alcanza, el cambio es
   **una clase nueva en `infrastructure/` y una linea en `src/main`**, porque el
   reconocimiento vive detras del puerto `PlateRecognizer`.
6. **(c) queda como el plan B explicito**, no como descarte. Si el conjunto de evaluacion
   muestra que Rekognition no pasa, Plate Recognizer con modelo regional de Bolivia es el
   siguiente adaptador — 20 USD por mil lecturas sigue siendo ~180 USD/mes a esta escala,
   caro pero pagable, y resuelve el problema de precision sin agregar MLOps. Lo que hay
   que resolver antes es el aviso de privacidad: salen imagenes de vehiculos de
   residentes identificables a un tercero.

**La conclusion honesta sobre (a):** si esto fuera un sistema de 50 porterias con 200 000
lecturas al mes, (a) seria la respuesta correcta —200 USD/mes de Rekognition frente a
14 USD de computo propio justifican el MLOps, y se compraria la licencia de Ultralytics o
se entrenaria un detector propio con una base permisiva. No es este caso, y optimizar
para una escala que no existe es el error que esta decision evita.

---

## 1. Arquitectura desplegada

```
 cliente de camara
   |  POST /captures  (rol CAMERA)
   v
 api (lambdalith, IN-VPC)  ->  presigned PUT
   |
   v
 S3  pacs-captures-dev/raw/...        <- lifecycle: 90 dias a Glacier IR, 400 dias borrar
   |  ObjectCreated:Put (prefix raw/, suffix .jpg)
   v
 plateRecognizer   FUERA de la VPC    <- ve S3 + Rekognition. Sin NAT, sin endpoints.
   |  DetectText (S3Object, sin transferir bytes)
   |  PutItem  pk = plateread#<captureId>
   v
 DynamoDB  pacs-events-dev  (stream NEW_IMAGE, ya existe)
   |
   +--> integrations   FUERA de la VPC   (ya existe, no cambia)
   |
   +--> plateIngest    DENTRO de la VPC  <- NUEVA. El stream la invoca; no necesita
           |                                 ruta de salida para ser invocada.
           v
        RDS hotel-db / pacs_dev   (IAM auth como pacs_app)
           plate_read + access_event + event_outbox
```

Lo que **no** se agrega: NAT gateway, endpoints de interfaz, Fargate, ECR. El endpoint
**gateway** de S3 solo haria falta si una funcion in-VPC leyera objetos; `plateIngest` no
lee imagenes, solo aplica el evento. Si mas adelante lo necesita, el gateway de S3 es
gratuito igual que el de DynamoDB.

---

## 2. El bloque de `serverless.yml`

Para pegar en `apps/api/serverless.yml`. Zip, no imagen: el handler compila con el mismo
esbuild del resto.

```yaml
# ------------------------------------------------------------------ custom
custom:
  captures:
    bucket: pacs-captures-${self:provider.stage}
    # Formatos que la camara puede subir. Cualquier otro se rechaza en el presigned.
    maxBytes: '8388608'          # 8 MiB: un JPEG de 1080p bien comprimido no llega
  plates:
    minFused: '0.85'
    reviewFused: '0.55'
    cooldownSeconds: '30'

# ----------------------------------------------------------------- provider
provider:
  environment:
    # Se suman a las que ya estan. El resto del bloque no cambia.
    CAPTURES_BUCKET: ${self:custom.captures.bucket}
    PLATES_MIN_FUSED: ${self:custom.plates.minFused}
    PLATES_REVIEW_FUSED: ${self:custom.plates.reviewFused}
    PLATES_COOLDOWN_SECONDS: ${self:custom.plates.cooldownSeconds}

# ---------------------------------------------------------------- functions
functions:
  # El reconocedor. FUERA de la VPC a proposito: es la segunda funcion con salida a
  # internet del servicio, por la misma razon que `integrations` (ADR-016). Sin esto
  # haria falta un endpoint de interfaz de Rekognition, ~7.30 USD por AZ al mes.
  plateRecognizer:
    handler: src/main/plate-recognizer.handler
    description: S3 -> Rekognition DetectText -> evento PlateRecognized (M-7)
    # 1024 MB y no 512: a 1769 MB se asigna 1 vCPU completo, y por debajo la fraccion es
    # proporcional. La funcion no calcula casi nada (la inferencia es de Rekognition),
    # pero decodifica y recorta el JPEG para el score de calidad. 1024 MB es el punto
    # donde la duracion deja de bajar; medir con Lambda Power Tuning antes de cambiarlo.
    memorySize: 1024
    # 30 s: DetectText responde en 300-700 ms. El margen es para un reintento del SDK
    # y para que un timeout sea siempre un sintoma, nunca lo normal.
    timeout: 30
    # No se necesita almacenamiento efimero extra: el JPEG se procesa en memoria y nada
    # se escribe en /tmp. Los 512 MB por defecto sobran.
    # ephemeralStorageSize: 512
    environment:
      REKOGNITION_MIN_TEXT_CONFIDENCE: '70'
      PLATE_BLOCKLIST: 'PARQUEO,PRIVADO,VISITAS,SALIDA,ENTRADA,RESERVADO,BOLIVIA,PROHIBIDO,ESTACIONAR,TAXI'
    events:
      - s3:
          bucket: ${self:custom.captures.bucket}
          event: s3:ObjectCreated:Put
          rules:
            - prefix: raw/
            - suffix: .jpg
          # El bucket lo crea este stack (ver resources). `existing: false` es el
          # comportamiento por defecto y lo deja explicito.
          existing: false

  # El consumidor in-VPC: aplica el evento a Postgres. El stream la invoca; una funcion
  # sin ruta de salida puede ser disparada por un stream, como ya hace `sweeper` con su
  # schedule.
  plateIngest:
    handler: src/main/plate-ingest.handler
    description: Stream consumer — PlateRecognized -> plate_read + access_event (M-7)
    memorySize: 512
    timeout: 30
    vpc: ${self:custom.vpc}
    events:
      - stream:
          type: dynamodb
          arn: !GetAtt EventsTable.StreamArn
          batchSize: 10
          startingPosition: LATEST
          maximumRetryAttempts: 3
          functionResponseType: ReportBatchItemFailures
          # Sin este filtro la funcion despierta con cada evento del outbox de Cognito
          # y de las asignaciones, y paga una conexion a RDS para descartarlos.
          filterPatterns:
            - eventName: [INSERT, MODIFY]
              dynamodb:
                Keys:
                  pk:
                    S: [{ prefix: 'plateread#' }]
```

### 2.1 Statements de IAM

Al bloque `provider.iam.role.statements` que ya existe, con los mismos criterios: sin
comodines de recurso.

```yaml
        # --------------------------------------------------- plates (M-7)
        # DetectText no acepta restriccion por recurso: la API de Rekognition no tiene
        # ARNs para las operaciones sin coleccion. Se acota por accion, que es lo unico
        # que el servicio permite, y se deja dicho aqui para que no parezca un descuido.
        - Effect: Allow
          Action: rekognition:DetectText
          Resource: '*'
        # Lectura de los fotogramas subidos, solo bajo raw/.
        - Effect: Allow
          Action:
            - s3:GetObject
            - s3:GetObjectAttributes
          Resource: !Sub '${CapturesBucket.Arn}/raw/*'
        # Escritura del recorte de la placa, que la pantalla de revision muestra.
        - Effect: Allow
          Action: s3:PutObject
          Resource: !Sub '${CapturesBucket.Arn}/crops/*'
        # El presigned PUT que entrega POST /captures. Firmar no llama a S3, pero el rol
        # debe tener el permiso que la URL firmada concede, o el PUT falla con 403.
        - Effect: Allow
          Action: s3:PutObject
          Resource: !Sub '${CapturesBucket.Arn}/raw/*'
        # Lectura del stream: necesaria para plateIngest. El bloque de `integrations`
        # probablemente ya la tiene; si no, es esta.
        - Effect: Allow
          Action:
            - dynamodb:DescribeStream
            - dynamodb:GetRecords
            - dynamodb:GetShardIterator
            - dynamodb:ListStreams
          Resource: !GetAtt EventsTable.StreamArn
```

El cooldown usa `pacs-cache` y la tabla de eventos usa `pacs-events`: ambas ya estan
cubiertas por los statements existentes de `GetItem`/`PutItem`/`DeleteItem`. No hace falta
nada mas.

### 2.2 El bucket y su ciclo de vida

En `resources.Resources`:

```yaml
    # --------------------------------------------------------- captures
    CapturesBucket:
      Type: AWS::S3::Bucket
      # Retain: las imagenes son evidencia de quien entro al edificio. Un
      # `serverless remove` no debe poder borrarlas.
      DeletionPolicy: Retain
      UpdateReplacePolicy: Retain
      Properties:
        BucketName: pacs-captures-${self:provider.stage}
        PublicAccessBlockConfiguration:
          BlockPublicAcls: true
          BlockPublicPolicy: true
          IgnorePublicAcls: true
          RestrictPublicBuckets: true
        BucketEncryption:
          ServerSideEncryptionConfiguration:
            - ServerSideEncryptionByDefault:
                SSEAlgorithm: AES256
              BucketKeyEnabled: true
        OwnershipControls:
          Rules:
            - ObjectOwnership: BucketOwnerEnforced
        VersioningConfiguration:
          Status: Enabled
        LifecycleConfiguration:
          Rules:
            # Un fotograma vale mientras alguien pueda discutir el acceso. Despues es
            # peso muerto, y es dato personal: se borra, no se guarda "por si acaso".
            - Id: raw-tiering
              Status: Enabled
              Prefix: raw/
              Transitions:
                - StorageClass: GLACIER_IR
                  TransitionInDays: 90
              ExpirationInDays: 400
            - Id: crops-expire
              Status: Enabled
              Prefix: crops/
              ExpirationInDays: 120
            - Id: abort-incomplete
              Status: Enabled
              AbortIncompleteMultipartUpload:
                DaysAfterInitiation: 1
        CorsConfiguration:
          CorsRules:
            # El PUT presignado lo hace el cliente de camara desde el navegador en el
            # modo de captura web. Solo PUT, solo el origen del frontend.
            - AllowedMethods: [PUT]
              AllowedOrigins:
                - ${self:custom.webOrigin.${self:provider.stage}, 'http://localhost:4200'}
              AllowedHeaders: ['*']
              MaxAge: 3600
```

Y en `resources.Outputs`:

```yaml
    CapturesBucketName:
      Value: !Ref CapturesBucket
```

### 2.3 Si en el futuro se elige la opcion (a): el bloque de contenedor

Para que quede escrito, porque es el plan de migracion:

```yaml
provider:
  ecr:
    images:
      plateCv:
        path: ./plate-cv              # Dockerfile + requirements
        platform: linux/arm64

functions:
  plateRecognizer:
    image:
      name: plateCv
    memorySize: 3008        # torch necesita >2 GB; y mas memoria = mas vCPU = menos ms
    timeout: 60             # el arranque frio solo son 8-15 s
    ephemeralStorageSize: 2048   # /tmp para los pesos de EasyOCR si no van horneados
    provisionedConcurrency: 1    # sin esto el primer auto del dia espera 12 s
```

Y los comandos, que son la parte que la gente olvida:

```bash
ACCOUNT=309887812390
REGION=us-east-2
REPO=pacs-plate-cv

aws ecr create-repository --repository-name $REPO \
  --image-scanning-configuration scanOnPush=true \
  --image-tag-mutability IMMUTABLE \
  --encryption-configuration encryptionType=AES256 \
  --profile hotel --region $REGION

aws ecr put-lifecycle-policy --repository-name $REPO --profile hotel --region $REGION \
  --lifecycle-policy-text '{"rules":[{"rulePriority":1,"description":"keep last 5",
    "selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":5},
    "action":{"type":"expire"}}]}'

aws ecr get-login-password --profile hotel --region $REGION \
  | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$REGION.amazonaws.com

# arm64 desde Windows: buildx + QEMU. Tarda 15-25 min la primera vez.
docker buildx create --use --name pacs 2>/dev/null || docker buildx use pacs
docker buildx build --platform linux/arm64 \
  -t $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$REPO:$(git rev-parse --short HEAD) \
  --push ./plate-cv

# `serverless deploy` con el bloque `provider.ecr.images` hace build y push solo;
# los comandos de arriba son para construir a mano o desde CI.
```

Con el `Dockerfile` basado en `public.ecr.aws/lambda/python:3.12-arm64`, horneando los
pesos de EasyOCR (`craft_mlt_25k.pth`, `english_g2.pth`) en `/opt/easyocr` y fijando
`EASYOCR_MODULE_PATH=/opt/easyocr`, porque el filesystem de Lambda es de solo lectura
salvo `/tmp` y descargarlos en cada arranque frio son 80 MB y varios segundos mas.

---

## 3. Secuencia de despliegue

```bash
cd D:/Unosquare/Promotion/code/apps/api

# 1. La migracion de las dos tablas nuevas. Desde el laptop, con DATABASE_URL exportada
#    como indica el README (el secreto dev/hotel-db/connection).
pnpm --filter @pacs/api exec node-pg-migrate create plates-schema
#    ... se escribe el DDL de MODULO-PLACAS.md seccion 2 ...
pnpm --filter @pacs/api migrate:up

# 2. El grupo CAMERA en el user pool. Va en serverless.yml junto a AdminGroup y
#    ResidentGroup; esto es solo para verificarlo despues.
# 3. Deploy.
serverless deploy --stage dev --aws-profile hotel --region us-east-2

# 4. Verificacion de que el trigger quedo atado al bucket.
aws s3api get-bucket-notification-configuration \
  --bucket pacs-captures-dev --profile hotel --region us-east-2
```

Dos cosas que muerden, en linea con las que el README ya documenta:

- **El nombre del handler no puede tener puntos.** Los archivos son
  `src/main/plate-recognizer.ts` y `src/main/plate-ingest.ts`, nunca
  `plate-recognizer.handler.ts`. El runtime parte el string del handler en el *primer*
  punto y falla con `Cannot find module 'plate-recognizer'`.
- **El trigger de S3 sobre un bucket que el mismo stack crea** hace que Serverless
  Framework genere un custom resource y una dependencia circular si el bucket se declara
  tambien en `resources`. Dos salidas: dejar que el evento `s3:` cree el bucket (y perder
  el control del cifrado y del lifecycle), o declarar el bucket en `resources` con
  `NotificationConfiguration` explicita y **no** usar el evento `s3:` de Serverless. La
  segunda es la correcta aqui, porque el lifecycle y `DeletionPolicy: Retain` importan:

```yaml
    CapturesBucket:
      Properties:
        NotificationConfiguration:
          LambdaConfigurations:
            - Event: s3:ObjectCreated:Put
              Filter:
                S3Key:
                  Rules:
                    - Name: prefix
                      Value: raw/
                    - Name: suffix
                      Value: .jpg
              Function: !GetAtt PlateRecognizerLambdaFunction.Arn
      DependsOn: PlateRecognizerLambdaPermissionS3

    PlateRecognizerLambdaPermissionS3:
      Type: AWS::Lambda::Permission
      Properties:
        FunctionName: !GetAtt PlateRecognizerLambdaFunction.Arn
        Action: lambda:InvokeFunction
        Principal: s3.amazonaws.com
        SourceAccount: !Ref AWS::AccountId
        SourceArn: !Sub 'arn:aws:s3:::pacs-captures-${self:provider.stage}'
```

`SourceArn` como string literal y no `!GetAtt CapturesBucket.Arn`: si se referencia el
bucket, CloudFormation ve bucket → permiso → bucket y aborta. El nombre del bucket es
determinista, asi que escribirlo rompe el ciclo. (El `AWS::Lambda::Permission` lo nombra
`PlateRecognizerLambdaPermissionS3`; el nombre logico de la funcion que genera Serverless
es `PlateRecognizerLambdaFunction` — en PascalCase a partir del nombre de la funcion.)

---

## 4. Variables de entorno

| Variable | Valor en dev | Para que |
|---|---|---|
| `CAPTURES_BUCKET` | `pacs-captures-dev` | Origen de los fotogramas y destino de los recortes |
| `EVENTS_TABLE` | `!Ref EventsTable` | Ya existe. Donde se escribe `plateread#<captureId>` |
| `CACHE_TABLE` | `!Ref CacheTable` | Ya existe. Donde vive el cooldown con TTL |
| `REKOGNITION_MIN_TEXT_CONFIDENCE` | `70` | Confianza minima que se le pide a `DetectText` por linea. Por debajo de 70 el ruido supera a las lecturas |
| `PLATES_MIN_FUSED` | `0.85` | Umbral de ALLOW automatico |
| `PLATES_REVIEW_FUSED` | `0.55` | Piso de la cola de revision; por debajo es `UNREADABLE` |
| `PLATES_COOLDOWN_SECONDS` | `30` | Ventana de dedupe por `(camara, placa)` |
| `PLATE_BLOCKLIST` | lista de la seccion 2 | Palabras de escena a descartar |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_NAME` | las de siempre | Solo `plateIngest`. Sin `DB_PASSWORD`: token IAM por conexion |

`PLATES_MIN_FUSED` y `PLATES_REVIEW_FUSED` estan **tambien** en `allocation_config` y la
base gana sobre la variable de entorno. La variable es el valor por defecto en un arranque
frio antes de la primera consulta; el `UPDATE` es lo que permite recalibrar sin deploy.

---

## 5. Costo por 1000 lecturas — us-east-2

### Opcion recomendada (b)

| Concepto | Calculo | USD |
|---|---|---|
| Rekognition `DetectText` | 1000 imagenes x 1.00 USD/1000 (primer millon al mes) | **1.0000** |
| Lambda `plateRecognizer` | 1024 MB arm64, ~700 ms: 1000 x 0.7 s x 1 GB = 700 GB-s x 0.0000133334 | 0.0093 |
| Lambda `plateIngest` | 512 MB arm64, ~120 ms: 60 GB-s x 0.0000133334 | 0.0008 |
| Peticiones Lambda | 2000 x 0.20 USD/1M | 0.0004 |
| S3 PUT | 1000 x 0.005 USD/1000 | 0.0050 |
| S3 GET (Rekognition lee el objeto) | 1000 x 0.0004 USD/1000 | 0.0004 |
| S3 almacenamiento | 1000 x 200 KB = 200 MB x 0.023 USD/GB-mes | 0.0046 |
| DynamoDB escrituras on-demand | ~2500 WRU x 1.25 USD/1M | 0.0031 |
| CloudWatch Logs | ~2 MB ingestados x 0.50 USD/GB | 0.0010 |
| **Total** | | **~1.025 USD / 1000 lecturas** |

Es **~0.001 USD por lectura**. Para el edificio: 300 lecturas/dia = 9000/mes =
**~9.25 USD/mes**, con el almacenamiento acumulado tendiendo a ~0.50 USD/mes adicional
bajo el lifecycle. X-Ray, que el provider ya tiene activo, agrega ~0.005 USD/1000 trazas.

### Para comparar

| Opcion | USD / 1000 lecturas | USD / mes a 9000 lecturas |
|---|---|---|
| (a) contenedor Python, sin provisioned concurrency | ~0.07 | ~0.80 + 0.15 de ECR |
| (a) contenedor Python, con provisioned concurrency 1 | ~0.07 | ~16 (la reserva se paga 24x7) |
| **(b) Rekognition** | **~1.03** | **~9.30** |
| (c) Plate Recognizer Cloud, plan bajo | ~20 | ~180 |

Con provisioned concurrency —que la opcion (a) necesita para ser usable en un porton— la
diferencia de costo entre (a) y (b) se invierte. Ese es el numero que sostiene la
recomendacion mas alla del argumento de licencia.

---

## 6. Prueba de punta a punta desde una shell

```bash
PROFILE=hotel
REGION=us-east-2
BUCKET=pacs-captures-dev
API=https://frd8e8nkhl.execute-api.us-east-2.amazonaws.com
CAPTURE_ID=$(node -e "process.stdout.write(Date.now().toString(36).toUpperCase()+Math.random().toString(36).slice(2,10).toUpperCase())")

# 0. Token de admin. El mismo camino que usan scripts/smoke.mjs y verify-cognito.mjs.
TOKEN=$(aws cognito-idp admin-initiate-auth \
  --user-pool-id us-east-2_NsdZ4M0mj \
  --client-id 2tu4q5vefr1g98u90u8dspmife \
  --auth-flow ADMIN_USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=$PACS_ADMIN_EMAIL,PASSWORD=$PACS_ADMIN_PASSWORD \
  --profile $PROFILE --region $REGION \
  --query 'AuthenticationResult.AccessToken' --output text)

# 1. Pedir el PUT presignado.
curl -sS -X POST "$API/captures" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"cameraId\":\"gate-north\",\"capturedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"contentType\":\"image/jpeg\"}" \
  | tee /tmp/capture.json
UPLOAD_URL=$(node -e "console.log(require('/tmp/capture.json').uploadUrl)")
CAPTURE_ID=$(node -e "console.log(require('/tmp/capture.json').captureId)")

# 2. Subir el fotograma. Una foto real de una placa; no un JPEG en blanco.
curl -sS -X PUT "$UPLOAD_URL" -H 'Content-Type: image/jpeg' --data-binary @./plate.jpg -w '%{http_code}\n'

# 2b. Atajo sin pasar por la API, util para aislar el reconocedor:
aws s3 cp ./plate.jpg "s3://$BUCKET/raw/gate-north/$(date -u +%Y/%m/%d)/$CAPTURE_ID.jpg" \
  --content-type image/jpeg \
  --metadata "capture-id=$CAPTURE_ID,camera-id=gate-north,captured-at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --profile $PROFILE --region $REGION

# 3. El evento en DynamoDB, ~1 s despues.
aws dynamodb get-item --table-name pacs-events-dev \
  --key "{\"pk\":{\"S\":\"plateread#$CAPTURE_ID\"}}" \
  --profile $PROFILE --region $REGION | jq '.Item.best, .Item.candidates'

# 4. La fila en Postgres, ~2 s despues (DATABASE_URL exportada como en el README).
psql "$DATABASE_URL" -c "SELECT capture_id, plate, raw_text, confidence, quality, status,
                                match_kind, match_distance
                           FROM plate_read WHERE capture_id = '$CAPTURE_ID';"
psql "$DATABASE_URL" -c "SELECT decision, reason, plate, resident_id
                           FROM access_event
                          WHERE plate_read_id = (SELECT id FROM plate_read
                                                  WHERE capture_id = '$CAPTURE_ID');"

# 5. Lo mismo via API.
curl -sS "$API/plate-reads?cameraId=gate-north&limit=5" -H "Authorization: Bearer $TOKEN" | jq .
curl -sS "$API/plate-reads/review" -H "Authorization: Bearer $TOKEN" | jq '.items | length'

# 6. Resolver una lectura dudosa.
READ_ID=$(curl -sS "$API/plate-reads/review" -H "Authorization: Bearer $TOKEN" | jq -r '.items[0].id')
curl -sS -X POST "$API/plate-reads/$READ_ID/resolve" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"plate":"1234ABC","decision":"ALLOW","note":"verificado por camara 2"}' | jq .

# 7. Idempotencia: reponer el MISMO objeto no debe crear una segunda fila.
aws s3 cp ./plate.jpg "s3://$BUCKET/raw/gate-north/$(date -u +%Y/%m/%d)/$CAPTURE_ID.jpg" \
  --content-type image/jpeg --metadata "capture-id=$CAPTURE_ID,camera-id=gate-north" \
  --profile $PROFILE --region $REGION
psql "$DATABASE_URL" -c "SELECT count(*) FROM plate_read WHERE capture_id = '$CAPTURE_ID';"
# Debe decir 1.

# 8. Logs, si algo no cuadra.
aws logs tail /aws/lambda/pacs-api-dev-plateRecognizer --since 10m --follow \
  --profile $PROFILE --region $REGION
aws logs tail /aws/lambda/pacs-api-dev-plateIngest --since 10m --follow \
  --profile $PROFILE --region $REGION

# 9. El motor aislado, sin nada del stack: la prueba mas rapida de si Rekognition
#    sirve con las camaras de este edificio.
aws rekognition detect-text \
  --image "{\"S3Object\":{\"Bucket\":\"$BUCKET\",\"Name\":\"raw/gate-north/$(date -u +%Y/%m/%d)/$CAPTURE_ID.jpg\"}}" \
  --profile $PROFILE --region $REGION \
  | jq -r '.TextDetections[] | select(.Type=="LINE") | "\(.DetectedText)\t\(.Confidence)"'
```

El paso 9 es el que conviene correr **antes** de escribir una sola linea de
infraestructura, contra 20 fotos reales del porton. Si ahi no aparecen las placas, la
recomendacion cambia a (c) y nada de lo construido se desperdicia: solo el adaptador.

---

## 7. Observabilidad y alarmas

Tres alarmas de CloudWatch, que son las que avisan antes de que se queje un residente:

```yaml
    PlateRecognizerErrors:
      Type: AWS::CloudWatch::Alarm
      Properties:
        AlarmName: pacs-${self:provider.stage}-plate-recognizer-errors
        Namespace: AWS/Lambda
        MetricName: Errors
        Dimensions:
          - Name: FunctionName
            Value: !Ref PlateRecognizerLambdaFunction
        Statistic: Sum
        Period: 300
        EvaluationPeriods: 1
        Threshold: 3
        ComparisonOperator: GreaterThanOrEqualToThreshold
        TreatMissingData: notBreaching

    PlateIngestIteratorAge:
      Type: AWS::CloudWatch::Alarm
      Properties:
        AlarmName: pacs-${self:provider.stage}-plate-ingest-lag
        Namespace: AWS/Lambda
        MetricName: IteratorAge
        Dimensions:
          - Name: FunctionName
            Value: !Ref PlateIngestLambdaFunction
        Statistic: Maximum
        Period: 300
        EvaluationPeriods: 2
        # 60 s de atraso en el stream significa que la bitacora de acceso va atrasada
        # respecto a los autos que ya entraron.
        Threshold: 60000
        ComparisonOperator: GreaterThanThreshold
        TreatMissingData: notBreaching
```

Y una metrica propia, emitida por `plateIngest` con Powertools (que el provider ya
configura con `POWERTOOLS_SERVICE_NAME: pacs`): `PlateReviewQueueDepth`. Si la cola de
revision pasa de 20 pendientes, los umbrales estan mal calibrados o una camara se movio.
Eso no lo dice ninguna metrica de AWS.
