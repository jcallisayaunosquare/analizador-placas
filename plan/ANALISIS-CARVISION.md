# Analisis de CarVision (salehabbaas/CarVision)

> Clonado el 2026-10-09 en `D:\Unosquare\analizador-placas\CarVision`.
> Todo el contenido descargado se trato como **dato no confiable**: solo se leyo.
> No se ejecuto ningun script, notebook, instalador ni build del repositorio.

---

## 1. Que es

CarVision es una plataforma **ANPR/ALPR autohospedada completa** para control de acceso
vehicular en porton: conectas camaras IP, defines una lista blanca de placas y el sistema
detecta, lee, clasifica ALLOWED/DENIED, registra el evento y notifica. El accionamiento
fisico del porton (rele/GPIO) **no esta implementado**; el README lo anuncia como
"coming in the next release".

No es una libreria ni un modelo: es un **producto monolitico** (FastAPI + React +
PostgreSQL + Docker Compose/Kubernetes) con 12 routers, gestor multicamara con hilos,
descubrimiento ONVIF, PTZ, grabacion de clips, importacion de datasets y un pipeline de
**entrenamiento YOLO propio** dentro de la misma aplicacion.

## 2. Stack real

| Capa | Tecnologia (version fijada en `requirements.txt`) |
|---|---|
| API | FastAPI 0.136.0 + uvicorn\[standard] 0.45.0 |
| ORM / migraciones | SQLAlchemy 2.0.49 + Alembic 1.18.4 + psycopg2-binary 2.9.10 |
| Vision | opencv-python-headless 4.11.0.86, imutils 0.5.4, numpy 2.2.6 |
| Deteccion | **ultralytics 8.4.41** (YOLOv8) — arrastra `torch` + `torchvision` |
| OCR | **easyocr 1.7.2** — arrastra `torch`, `torchvision`, `Pillow`, `scipy`, `shapely` |
| Camaras | onvif-zeep 0.2.12, wsdiscovery 2.0.0 |
| Seguridad | PyJWT 2.12.1, cryptography 46.0.7 (Fernet para credenciales ONVIF), itsdangerous |
| Modelos | huggingface_hub 1.11.0 (descarga de modelos base para reentrenar) |
| Frontend | React 18.3 + TypeScript + Vite + Tailwind, servido por nginx |
| Despliegue | Docker Compose (cpu / nvidia / mac) y Kubernetes con HPA |
| Python | 3.11 (`deploy/docker/backend.Dockerfile`, CI) |

## 3. Modelos y pesos

Dos checkpoints de PyTorch estan **commiteados dentro del repositorio**:

| Archivo | Tamano | Que es |
|---|---|---|
| `models/plate.pt` | 6 096 KB | Fine-tune YOLOv8n de **una sola clase: `plate`**. Los metadatos del checkpoint lo confirman: `names = {0: 'plate'}`, `train_args.data = /app/datasets/media/training_yolo_jobs/.../chunk_0007/data.yaml`, run `..._c0007_20260416_005016`. Es el `best.pt` de una corrida del entrenador interno del propio producto. |
| `backend/app/yolov8n.pt` | 6 396 KB | **YOLOv8n COCO preentrenado de Ultralytics**, sin modificar. Se usa como base de entrenamiento / fallback. |

**Metricas que vienen embebidas en `models/plate.pt`** (leidas del `data.pkl` del
checkpoint, no publicadas en ningun documento del repo):

```
metrics/precision(B)  0.99901
metrics/recall(B)     1.00000
metrics/mAP50(B)      0.99500
metrics/mAP50-95(B)   0.68567
fitness               0.71660
```

Hay que leerlas con escepticismo: son del **split de validacion de su propio
`chunk_0007`**, generado por el mismo importador que armo el train. Un recall de
exactamente 1.0 en deteccion es la firma clasica de fuga train/val. Y, en cualquier caso,
**miden solo localizacion del rectangulo de la placa, no la lectura del texto**.

El OCR (EasyOCR) descarga sus propios pesos en tiempo de ejecucion
(`craft_mlt_25k` + `english_g2`, ~80 MB); no estan en el repo. En Lambda eso hay que
hornearlo en la imagen, porque el filesystem es de solo lectura salvo `/tmp`.

## 4. Licencias — el punto decisivo

| Elemento | Situacion real |
|---|---|
| Repositorio CarVision | **No hay archivo `LICENSE`.** El README muestra un badge `License-MIT` que apunta a `LICENSE`, un enlace roto. Sin archivo de licencia, el codigo es *all rights reserved* por defecto. |
| `ultralytics` 8.4.41 | **AGPL-3.0**. |
| `models/plate.pt` y `yolov8n.pt` | El propio checkpoint lleva el campo `license: "AGPL-3.0 (https://ultralytics.com/license)"`. |
| `easyocr` | Apache-2.0 (sus pesos CRAFT/`english_g2` tienen terminos propios, Apache-2.0 / investigacion). |
| `opencv-python-headless` | Apache-2.0. |

### Veredicto de licencia

1. **No podemos reutilizar codigo de CarVision.** Sin `LICENSE`, no hay concesion de
   derechos. El badge MIT no es una licencia; es una imagen. Reusar archivos seria
   apostar a que nadie lo note.
2. **No podemos usar `plate.pt` ni `ultralytics`** en un servicio propietario sin
   aceptar AGPL-3.0, que al servirse por red obliga a publicar el fuente de **todo el
   servicio** que lo incorpora, o a comprar la licencia comercial de Ultralytics.
3. Lo que **si** podemos tomar sin riesgo: **las ideas**. Un pipeline por etapas, el
   scoring de calidad del recorte, la fusion de confianza, el cooldown por placa, la
   generacion de variantes O/0 e I/1. Son tecnicas, no expresion protegible, y las
   reimplementamos en TypeScript desde cero.

## 5. El pipeline de inferencia, etapa por etapa

El README promete "10-stage recognition pipeline". El codigo real
(`backend/app/pipeline/orchestrator.py`) tiene 10 llamadas, pero **cuatro son stubs**:

| # | Etapa | Archivo | Que hace de verdad |
|---|---|---|---|
| 1 | Frame selector | `pipeline/frame_selector.py` | **Stub.** Envuelve el frame recibido en un dataclass. No elige "el frame mas nitido": no compara nada. |
| 2 | Plate localizer | `pipeline/plate_localizer.py` → `app/plate_detector.py` | Real. Modo `yolo`, `contour` o `auto`. En `auto` lanza ambos en un `ThreadPoolExecutor(2)` y elige por score. |
| 3 | Cropper | `pipeline/plate_cropper.py` → `anpr.crop_from_bbox` | Real. Recorte por bbox (dict `x1,y1,x2,y2` o poligono). |
| 4 | Quality scorer | `pipeline/plate_quality.py` | **Real y util.** Varianza del Laplaciano + brillo + contraste + densidad de bordes Canny, combinados `0.4/0.2/0.2/0.2`. Umbral `ANPR_PLATE_QUALITY_MIN=0.25`. |
| 5 | Rectifier | `pipeline/plate_rectifier.py` | **Stub.** `debug={"note": "pass_through"}`. No corrige perspectiva ni rotacion. |
| 6 | Classifier | `pipeline/plate_classifier.py` | **Stub.** Siempre devuelve `plate_type="unknown"`, `debug={"note":"heuristic_stub"}`. |
| 7 | OCR | `pipeline/plate_ocr.py` → `anpr.read_plate_text` | Real. EasyOCR sobre 2 variantes rapidas (RGB + gris reescalado a 320 px de ancho) y, solo si no hubo texto, 2 variantes extendidas (bilateral + umbral adaptativo). |
| 8 | Post-process | `pipeline/postprocess.py` → `anpr.normalize_plate` | Real pero **hardcodeado a formatos israeli/palestino**. |
| 9 | Confidence fusion | `pipeline/confidence.py` | Real y simple: `conf_ocr * (0.6 + 0.4 * quality_score)`. |
| 10 | Tracker | `pipeline/tracker.py` | **Stub.** Siempre `status="candidate"`, `debug={"note":"temporal_stub"}`. No vota entre frames. |

**No existe etapa de deteccion de vehiculo.** El flujo del enunciado
"frames → deteccion de vehiculo → deteccion de placa → OCR" aqui es
"frame → deteccion de placa → OCR". El `yolov8n.pt` de COCO esta en el repo pero no
alimenta ningun paso de "car/truck/bus"; se usa como base de entrenamiento.

El seguimiento temporal real no esta en el pipeline sino en
`camera_manager.py`: cooldown por placa (`Camera.cooldown_seconds`, 10 s por defecto),
un "allowed stationary hold" que evita re-disparar con el auto detenido, y un hash de
thumbnail del ultimo escaneo para saltar frames identicos.

### El OCR en detalle (`backend/app/anpr.py`, 22 KB — el archivo que importa)

- Lector EasyOCR unico compartido, con `threading.Lock` y **precalentamiento en un hilo
  demonio al importar el modulo** (una imagen blanca 64x16) para no pagar 3-6 s en el
  primer frame.
- Cache LRU de 8 entradas con clave `sha1(crop.tobytes())[:16]`, que cachea tambien los
  fallos para no repetir OCR del mismo recorte.
- `_pick_best()`: por cada lectura de EasyOCR genera **variantes ambiguas**
  (`AMBIGUOUS_TO_DIGIT = {O:0, I:1, Z:[7,2], S:5, B:8, G:6, Q:0, D:0, T:7}` y su inverso),
  las puntua y se queda con la mejor; **descarta si el score < 80.0**.
- `_score_candidate_norm()`: heuristica sumativa — confianza x100, +2 por caracter,
  +20 si tiene digitos, -200 si no tiene ninguno, bonus por patron
  (`\d{7}`: +80, `[A-Z]{4}\d{3}`: +80, `[A-Z]{3}\d{3}`: +60...), penalizacion si la
  longitud sale de `[plate_min_length, plate_max_length]`, y una **lista negra de
  palabras** (`STREET`, `PARKING`, `ONTARIO`, `QUEBEC`...) para que no lea carteles.
- `detect_plate()` por contornos (fallback sin YOLO): gris → `bilateralFilter(11,17,17)`
  → `Canny(30,200)` → 10 contornos mayores por area → el primer `approxPolyDP` de 4
  vertices; si no hay, `minAreaRect` del mayor. Descarta recortes que ocupen >70% del
  ancho o >60% del alto del frame.

### `normalize_plate()` no nos sirve

```python
if compact.startswith("IL"): compact = compact[2:]
if compact.endswith("P"):    compact = compact[:-1]
if re.fullmatch(r"\d[.\-]?\d{4}-?\d{1,2}", compact): return re.sub(r"\D","",compact)
if re.fullmatch(r"\d{2}-?\d{3}-?\d{1,2}", compact): return re.sub(r"\D","",compact)
```

Los tests lo confirman (`tests/test_anpr_plate_normalization.py`): `"1.2345-6 P" → "123456"`,
`"IL 12-345-67" → "1234567"`. Es un normalizador **israeli/palestino**, numerico. Una
placa boliviana `1234ABC` cae al camino generico y, peor, la regla
`if compact.endswith("P")` mutila cualquier placa que termine en P. **Se descarta por
completo** y se reescribe para Bolivia.

## 6. Formatos de entrada y salida

**Entrada** (`backend/app/routers/upload.py`, `cameras.py`, `live.py`):
- RTSP, MJPEG HTTP, webcam USB, captura desde el navegador, ONVIF autodescubierto.
- `POST /api/v1/upload/start`: `multipart/form-data` con `file`, `sample_seconds=1.0`,
  `max_frames=300`, `show_debug`. Tope duro de 500 MB. Responde `{"ok":true,"job_id":...}`
  y procesa en un `threading.Thread`; el cliente consulta `GET /api/v1/upload/status/{job_id}`.
  Es un patron de job en memoria de proceso: se pierde al reiniciar y **no sobrevive a Lambda**.

**Salida** — `PlateInferenceResult.to_legacy_detection()`:

```json
{ "plate_text": "1234ABC", "confidence": 0.81,
  "bbox": {"x1":120,"y1":400,"x2":260,"y2":455,"detector_conf":0.93},
  "raw_text": "1234 ABC", "candidates": [ /* hasta 8, con score */ ] }
```

Persistido en la tabla `detections` (`backend/app/models.py`): `plate_text`,
`confidence`, `status` (`allowed`/`denied`/`unknown`), `image_path`, cinco rutas de
imagenes de debug, `bbox` JSON, `raw_text`, `detector`, `image_hash` y campos de
`feedback_*` para la revision humana.

## 7. La decision de acceso en CarVision

`camera_manager.py::_is_allowed()`:

```python
rows = db.query(AllowedPlate.plate_text).filter(AllowedPlate.active.is_(True)).all()
return plate_text.upper() in self._allowed_cache   # cache de 20 s
...
status = "allowed" if allowed else "denied"
```

Es **igualdad exacta sobre el conjunto completo en memoria**, con cache de 20 segundos.
No hay umbral de confianza antes de persistir, no hay match difuso, no hay distancia de
edicion y el estado `unknown` que declara el modelo nunca se escribe. Una lectura con
confianza 0.31 produce un `denied` definitivo igual que una de 0.98.

## 8. Mapa archivo por archivo de lo que importa

| Archivo | KB | Para que lo miramos |
|---|---|---|
| `backend/app/anpr.py` | 21.9 | **El nucleo.** OCR, normalizacion, scoring, variantes ambiguas, fallback por contornos. La fuente de las ideas que portamos. |
| `backend/app/plate_detector.py` | 10.8 | YOLO vs contornos, modo `auto` concurrente, `imgsz=320`, precalentamiento, recarga de modelo. |
| `backend/app/pipeline/orchestrator.py` | 9.0 | Orden de etapas y, sobre todo, los `return None` tempranos: donde se cae un frame. |
| `backend/app/pipeline/plate_quality.py` | 2.1 | La metrica de calidad de recorte. Reimplementable casi literal en concepto. |
| `backend/app/pipeline/confidence.py` | 1.1 | La formula de fusion. Dos lineas, utiles. |
| `backend/app/camera_manager.py` | 42.3 | Cooldown, hold estacionario, dedupe por hash, decision allow/deny. No portable (hilos + estado en proceso). |
| `backend/app/models.py` | 8.9 | El modelo de datos de referencia (`detections`, `allowed_plates`). |
| `backend/migrations/versions/0001_initial_schema.py` | 8.0 | DDL real del esquema. |
| `backend/app/routers/upload.py` | 2.6 | Contrato de entrada por archivo. |
| `backend/app/routers/allowed.py` | 2.5 | CRUD de lista blanca; normaliza con `isalnum()` + `upper()`. |
| `tests/test_anpr_plate_normalization.py` | 1.8 | Prueba que la normalizacion es israeli/palestina. El argumento para descartarla. |
| `deploy/docker/backend.Dockerfile` | 0.5 | `python:3.11-slim` + `build-essential libgl1 libglib2.0-0 ffmpeg`. Referencia de dependencias de sistema de OpenCV. |
| `requirements.txt` | 0.4 | Versiones exactas, y la prueba de AGPL via `ultralytics`. |
| `models/plate.pt` | 6 096 | El peso. AGPL-3.0, una clase. **No se usa.** |

Lo demas —`routers/training*.py` (81 KB entre dos archivos), `_training_worker.py`,
`services/dataset.py`, `onvif_*`, `stream_manager.py`, los 190 KB de frontend React y
los manifiestos de Kubernetes— es la carcasa de producto autohospedado. Irrelevante para
un modulo serverless.

## 9. Calidad del repositorio, honestamente

A favor: versiones fijadas, migraciones Alembic versionadas, `pytest` y CI en GitHub
Actions, Fernet para credenciales ONVIF, un guardia de tamano de archivo
(`scripts/check_file_sizes.py`), y un README excelente.

En contra, y pesa:
- **Sin LICENSE** pese al badge MIT.
- **Cuatro de diez etapas son stubs** y el README las presenta como funcionales
  ("sharpest frame wins", "corrects skew & angle", "links frames together").
- **Cero metricas publicadas.** No hay benchmark, ni dataset de evaluacion, ni una sola
  cifra de accuracy de OCR en README, SETUP ni CODE_REVIEW.
- Pesos binarios de 12 MB commiteados en git.
- `plate_detector._score()` devuelve 0 para el resultado YOLO (nunca trae
  `candidates` ni `confidence`, solo `bbox.detector_conf`), asi que en modo `auto` el
  detector por contornos gana casi siempre el desempate. El modo "auto" no hace lo que
  dice el comentario.
- Estado de trabajos en memoria del proceso y hilos demonio: arquitectura de servidor
  largo, incompatible con una funcion efimera.

## 10. Que tomamos y que dejamos

### Tomamos (como ideas, reimplementadas en TypeScript)

1. **El pipeline por etapas con cortes tempranos.** Que cada etapa devuelva o aborte, y
   que el abort se registre con su motivo. Es el esqueleto de nuestro `recognizePlate`.
2. **El scoring de calidad del recorte** (Laplaciano/contraste/bordes/brillo) como
   compuerta antes de gastar en OCR, y como senal para la cola de revision.
3. **La fusion de confianza** `conf_ocr * (0.6 + 0.4 * quality)`.
4. **La generacion de variantes ambiguas** O/0, I/1, S/5, B/8, G/6, Z/2, Q/0, D/0, T/7.
   Esto es exactamente lo que necesitamos, solo que aplicado a formatos bolivianos.
5. **El scoring por patron**: premiar candidatos que encajan en el formato del pais.
6. **La lista negra de palabras de escena** para que el OCR no confunda un cartel con
   una placa.
7. **El cooldown por placa** como regla de idempotencia de negocio.
8. **El modelo de datos**: `detections` + `allowed_plates` + campos `feedback_*` para la
   revision humana es la forma correcta, y la adoptamos como `plate_read` + `access_event`.

### Dejamos

1. **Todo el codigo** — sin licencia, no se copia una linea.
2. **`ultralytics` y `plate.pt`** — AGPL-3.0 sobre un servicio propietario.
3. **`normalize_plate()`** — formatos israeli/palestino, y una regla que mutila placas
   terminadas en P.
4. **`camera_manager.py`** — hilos, estado en proceso, cache de 20 s. En serverless el
   equivalente correcto es DynamoDB con TTL, que ya tenemos.
5. **Las etapas stub** (frame selector, rectifier, classifier, tracker). No aportan nada
   y no vale portar un `pass_through`.
6. **Los jobs de upload en memoria** — se reemplazan por S3 + evento + outbox.
7. **El entrenador YOLO embebido, ONVIF, PTZ, clips, Kubernetes, el frontend React** —
   fuera de alcance.
8. **El modo `auto` concurrente YOLO+contornos** — en Lambda la concurrencia interna por
   hilos solo multiplica el costo de un vCPU que se cobra por GB-segundo.

### Conclusion

CarVision es una referencia **arquitectonica** valiosa y una fuente **legal inutilizable**.
Nos dice como se ve un ALPR completo y cuales son los problemas reales (calidad de
recorte, caracteres ambiguos, dedupe temporal, revision humana). No nos da nada que
podamos desplegar.
