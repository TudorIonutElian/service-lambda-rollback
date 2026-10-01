# Architecture diagram prompt

Text to give an image-generating LLM so it draws the architecture of this repository.
Copy the **Full prompt** for models that accept long inputs, or the **Short prompt** for models with a
small prompt limit. The **Reference** section afterwards lists every component and flow, in case
the model misses or invents something.

---

## Full prompt

```text
Create a clean, professional AWS cloud architecture diagram in the style of official AWS
architecture diagrams: white background, official AWS service icons (2023+ icon set), thin
labelled arrows, rounded group boxes, sans-serif font, no 3D, no people, no decorative art.
Landscape 16:9. All text must be legible and spelled exactly as given below.

TITLE (top): "service-lambda — automatic & manual rollback"
SUBTITLE: "Every version is archived (metadata in DynamoDB, package in S3). Roll back by moving the
'live' alias to an archived version and restoring $LATEST from its zip. No rebuild."

LAYOUT (left to right):
Column 1 (far left): a box labelled "GitHub" containing a repository icon labelled
"service-lambda-rollback repo" and three GitHub Actions workflow boxes stacked vertically:
  - "Deploy — on push to main — cdk deploy + sync"
  - "Deploy branch — manual, choose branch — cdk deploy + sync"
  - "Rollback — manual — inputs: target_version, dry_run"
Next to the workflows, a small key icon labelled "Secrets: AWS_ACCESS_KEY_ID,
AWS_SECRET_ACCESS_KEY, AWS_REGION".

Columns 2–4: a large box labelled "AWS account / region", containing a CloudFormation icon
at the top labelled "CloudFormation stack: ServiceLambdaStack (AWS CDK)" with a thin dashed line
indicating it creates every resource in the box.

Inside the AWS box, four group boxes: "Service" (top left), "Detection" (top middle),
"Rollback" (top right) and "Version archive" (bottom, spanning under Detection and Rollback).

GROUP A — "Service":
  - A small "Callers" icon (generic client) outside the group, on its left edge, with two arrows:
      solid arrow labelled "invoke service-lambda:live" to the alias,
      dashed arrow labelled "invoke unqualified (console Test)" to $LATEST.
  - A Lambda icon labelled "service-lambda (Node.js 22)".
  - Under it, a horizontal row of small version tiles: "v1", "v2", "v3 … vN", each with a tiny
    caption "description: <commit hash + message>". Caption the row "Published versions
    (immutable, retained)".
  - A tag/pointer shape labelled "Alias: live" pointing to one of the version tiles (e.g. "v3").
  - A separate tile labelled "$LATEST (unpublished code)".

GROUP B — "Detection":
  - A CloudWatch Metrics icon labelled "AWS/Lambda Errors" with three small metric lines labelled
    "Resource = service-lambda:live", "Resource = service-lambda", "Resource = service-lambda:$LATEST".
  - A CloudWatch Alarm icon labelled "Alarm: service-lambda-errors" with caption
    "FILL(live,0) + FILL(unqualified,0) + FILL(latest,0) ≥ 1 in 1 minute".
  - An SNS icon labelled "SNS topic: service-lambda-rollback-notifications".
  - An EventBridge icon labelled "EventBridge rule (default bus): service-lambda-rollback-check"
    with caption "rate(5 minutes): sync + re-check alarms".

GROUP C — "Rollback":
  - A Lambda icon labelled "service-lambda-rollback".
  - Attached to it, a small document icon labelled "config.json — registered functions, alias,
    alarms, enabled flag, maxConsecutiveRollbacks".
  - Directly below the rollback Lambda, a small numbered checklist box labelled "Pre-hook":
      "1. Function registered & enabled in config.json?"
      "2. Alarm registered for that function?"
  - A second small checklist box labelled "Before rolling back (from DynamoDB CURRENT)":
      "Cooldown (3 min) passed?"
      "Under max consecutive rollbacks?"
  - An STS icon labelled "STS AssumeRole + session policy (one function: its Lambda, its S3
    folder, its DynamoDB items)".
  - An IAM role icon labelled "RollbackExecutionRole — upper bound: registered functions only".
  - A CloudWatch Logs icon labelled "Rollback logs".

GROUP D — "Version archive":
  - A DynamoDB icon labelled "DynamoDB: service-lambda-rollback-versions".
    Next to it, a small table sketch with two rows:
      "functionName | sk = VERSION#0000000003 | codeSha256, description, runtime, s3Key, rolledBackBy…"
      "functionName | sk = CURRENT | version, previousVersion, updatedBy, lastRollbackAt, rollbackCount"
  - An S3 bucket icon labelled "S3: service-lambda-rollback-artifacts-<account>-<region>".
    Inside or under it, three small zip-file icons labelled
    "service-lambda/service-lambda-1.zip", "service-lambda/service-lambda-2.zip",
    "service-lambda/service-lambda-3.zip".

ARROWS (number them with small circled numbers so the flow can be followed):
  (1) GitHub "Deploy" and "Deploy branch" → CloudFormation: "cdk deploy (publishes new version,
      moves live)".
  (2) GitHub "Deploy" and "Deploy branch" → service-lambda-rollback: "invoke { type: sync }".
  (3) Alias "live" / "$LATEST" → CloudWatch Errors metrics: "errors".
  (4) Metrics → Alarm.
  (5) Alarm → SNS: "on OK → ALARM".
  (6) SNS → service-lambda-rollback: "alarm message".
  (7) EventBridge → service-lambda-rollback: "every 5 min: scheduled-check".
  (8) service-lambda-rollback → CloudWatch Alarm (dashed): "DescribeAlarms — still in ALARM?".
  (9) service-lambda-rollback → config.json (dashed): "read registrations".
  (10) service-lambda-rollback → STS → RollbackExecutionRole: "AssumeRole, scoped credentials".
  (11) service-lambda-rollback → published versions (dashed, teal): "sync: list versions,
       download new packages".
  (12) service-lambda-rollback → S3 (teal): "archive <fn>-<version>.zip".
  (13) service-lambda-rollback → DynamoDB (teal, both directions): "version metadata, CURRENT,
       rollback history".
  (14) service-lambda-rollback → Alias "live" (thick, orange-red): "UpdateAlias → previous
       archived version".
  (15) S3 zip → $LATEST (thick, orange-red): "UpdateFunctionCode from S3 ($LATEST, no publish)".
  (16) service-lambda-rollback → CloudWatch Logs: "logs".
  (17) GitHub "Rollback" workflow → DynamoDB (purple dashed): "read archived versions, record
       rollback".
  (18) GitHub "Rollback" workflow → Alias "live" and S3 zip → $LATEST (thick, purple, dashed):
       "manual rollback: UpdateAlias + restore $LATEST from S3 (dry run: list versions only)".

COLOURS:
  - Deploy and data flow arrows: dark grey.
  - Sync / archive arrows (11, 12, 13): teal.
  - Automatic rollback actions (14, 15): orange-red.
  - Manual rollback (17, 18): purple.
  - Group boxes: very light tints (Service: light blue, Detection: light pink,
    Rollback: light orange, Version archive: light green). GitHub box: light grey.

LEGEND (bottom right):
  "Solid grey = deploy / data flow", "Teal = sync / archive", "Orange-red = automatic rollback",
  "Purple dashed = manual rollback (GitHub Actions)", "Dashed thin = read-only call".

FOOTER NOTE (bottom left, small text):
  "Rollback never rebuilds. Sync archives every published version to S3 + DynamoDB; rollback points
  'live' at an archived version and restores $LATEST from its zip. A deploy resets the rollback count."

Do not add services that are not listed. Do not draw VPCs, API Gateway, RDS or load balancers.
```

---

## Short prompt

```text
AWS architecture diagram, official AWS icons, white background, left-to-right, labelled arrows, 16:9.
Left: GitHub box with workflows "Deploy (push to main) + sync", "Deploy branch (manual) + sync",
"Rollback (manual, dry_run)". Right: "AWS account" box created by "CloudFormation: ServiceLambdaStack
(CDK)". Inside: Lambda "service-lambda" with version tiles v1…vN, alias "live" pointing at one
version, and "$LATEST". CloudWatch "Errors" metrics for live and $LATEST → CloudWatch Alarm
"service-lambda-errors" (≥1 error/min) → SNS "service-lambda-rollback-notifications" → Lambda
"service-lambda-rollback". EventBridge rule "service-lambda-rollback-check, rate(5 minutes)" → same
rollback Lambda. A "Version archive" group with DynamoDB "service-lambda-rollback-versions" (rows
VERSION#… and CURRENT) and S3 "service-lambda-rollback-artifacts" holding
"service-lambda/service-lambda-<version>.zip". Rollback Lambda reads "config.json" (pre-hook:
registered function + alarm), calls STS AssumeRole for scoped credentials, syncs versions to S3 and
DynamoDB (teal arrows), then (orange arrows) "UpdateAlias live → previous archived version" and
"UpdateFunctionCode $LATEST from S3 zip". GitHub "Rollback" workflow does the same manually (purple
dashed arrows). Legend: grey = deploy, teal = sync/archive, orange = automatic rollback, purple =
manual. No VPC, API Gateway or RDS.
```

---

## Reference

What actually exists in this repository, to check the generated image against.

### Components

| Component | Name | Defined in |
|---|---|---|
| GitHub Actions workflow | `Deploy` (push to `main`, `cdk deploy`, then sync) | `.github/workflows/deploy.yml` |
| GitHub Actions workflow | `Deploy branch` (manual, `branch` input, `cdk deploy`, then sync) | `.github/workflows/deploy-branch.yml` |
| GitHub Actions workflow | `Rollback` (manual, `target_version`, `dry_run`) | `.github/workflows/rollback.yml` |
| CloudFormation stack (CDK) | `ServiceLambdaStack` | `bin/app.ts`, `lib/service-stack.ts` |
| Lambda function | `service-lambda` (logs its version) | `lambda/index.mjs` |
| Lambda versions | published per code/config change, retained, description = last commit touching `lambda/` | `lib/service-stack.ts` |
| Lambda alias | `live` | `lib/service-stack.ts` |
| CloudWatch alarm | `service-lambda-errors` (metric math over `live`, unqualified and `$LATEST` errors, ≥ 1 in 1 min) | `lib/service-stack.ts` |
| SNS topic | `service-lambda-rollback-notifications` | `lib/service-stack.ts` |
| EventBridge rule (default bus) | `service-lambda-rollback-check`, `rate(5 minutes)` | `lib/service-stack.ts` |
| DynamoDB table | `service-lambda-rollback-versions` (PK `functionName`, SK `sk`: `VERSION#…` / `CURRENT`) | `lib/service-stack.ts` |
| S3 bucket | `service-lambda-rollback-artifacts-<account>-<region>`, keys `<fn>/<fn>-<version>.zip` | `lib/service-stack.ts` |
| Lambda function | `service-lambda-rollback` (sync/archive, alarm handling, rollback) | `lambda-rollback/index.mjs` |
| Config | registered functions, alias, alarms, `enabled`, `maxConsecutiveRollbacks` | `lambda-rollback/config.json` |
| IAM role | `RollbackExecutionRole` (Lambda, S3 and DynamoDB permissions for registered functions only) | `lib/service-stack.ts` |
| STS | `AssumeRole` with a session policy scoped to one function, its S3 folder and its DynamoDB items | `lambda-rollback/index.mjs` |

### Flows

1. **Deploy:** GitHub Actions runs `cdk deploy`, which publishes a new version (with a commit description) and moves `live` to it, then invokes `service-lambda-rollback` with `{ "type": "sync" }`.
2. **Sync / archive:** for each registered function, new versions are downloaded from Lambda and stored as `<fn>/<fn>-<version>.zip` in S3, with their metadata in DynamoDB (`VERSION#…`). If the alias moved outside the rollback system, `CURRENT` is updated as a deploy and the rollback count resets.
3. **Detect:** errors from `service-lambda:live` or `$LATEST` raise `service-lambda-errors` to `ALARM`.
4. **Notify:** the alarm publishes to the SNS topic on `OK → ALARM`, which invokes `service-lambda-rollback`.
5. **Re-check:** every 5 minutes EventBridge invokes `service-lambda-rollback`, which syncs, reads the registered alarms (`DescribeAlarms`) and treats any still in `ALARM` as if it had just fired.
6. **Pre-hook:** the function must be registered and enabled in `config.json`, and the alarm must be registered for it.
7. **Scoped credentials:** STS `AssumeRole` on `RollbackExecutionRole`, with a session policy limited to that one function, its S3 folder and its DynamoDB items.
8. **Guards:** from the `CURRENT` item, the 3-minute cooldown must have passed and the consecutive-rollback limit must not be reached.
9. **Roll back the alias:** `UpdateAlias live` → highest archived version below the current one.
10. **Restore `$LATEST`:** `UpdateFunctionCode` on `$LATEST` from the target's S3 zip (no publish) → verify the code hash.
11. **Record:** `CURRENT` is updated (`auto-rollback`, count + 1, `lastRollbackAt`), and the version rolled back from gets `rolledBackAt` / `rolledBackBy` / `rollbackReason`.
12. **Manual rollback:** the `Rollback` workflow syncs, reads the archived versions from DynamoDB, then does steps 9–11 with the AWS CLI (`manual-rollback`, count reset to 0). With `dry_run` it only lists versions and what it would do.
