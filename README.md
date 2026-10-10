# analizador-placas — license plate recognition for PACS

The study that produced the plate recognition module of
[PACS](https://github.com/jcallisayaunosquare/pacs-parking-allocation): what an existing
open-source ALPR project does, what of it was worth adopting, and how the capability was
designed for a serverless system that already existed.

It is kept separate from the product repository on purpose. This is the reading and the
reasoning; the shipped module lives in PACS under `apps/api/src/modules/plates/`.

## What is here

| Path | What it is |
|---|---|
| `plan/ANALISIS-CARVISION.md` | A reading of the upstream CarVision project: its pipeline, its model choices, what transfers to our constraints and what does not |
| `plan/MODULO-PLACAS.md` | The module design — capture flow, the two Lambdas, the matching rules, the decision table, the data model |
| `plan/DESPLIEGUE-LAMBDA.md` | How the recogniser is packaged and deployed, with the costs and the limits that shaped it |
| `plan/lambda/` | A self-contained, runnable scaffold of the recogniser, written to be verified before any of it entered the product |

## What is deliberately not here

**The CarVision clone.** It was read, not vendored. It carries no licence file, which
means its author keeps all rights to it by default, so it is not ours to redistribute —
it is referenced instead: <https://github.com/salehabbaas/CarVision>. `.gitignore`
excludes the working copy so it cannot be committed by accident.

## What became of it

The design in `MODULO-PLACAS.md` was built and runs on AWS. The shape survived contact:
a presigned S3 PUT from the camera, an S3 notification waking a recogniser outside the
VPC, Rekognition `DetectText`, a `PlateRecognized` event on a DynamoDB table, and a
stream consumer inside the VPC that writes the read, matches it against the resident
vehicle register and records an access decision.

Two things changed once real frames went through it, and both are worth reading the
documents against:

- The S3 notification filter has to cover every extension the capture API accepts. It
  was written for `.jpg` only, and PNG frames landed in the bucket with nothing watching
  for them — no error, no read, no row.
- The cooldown that collapses one arriving car into one arrival keeps the *first* frame
  that produced a decision, and the first frame is the one taken while the car was still
  entering the lane. It is usually the worst of the set. The scaffold does not solve
  this and neither does the deployed module yet.

The accuracy of `DetectText` on real gate photographs has still not been measured. Every
number quoted in these documents about recognition quality comes from rendered test
images and a plate held up to a webcam, and should be read that way.
