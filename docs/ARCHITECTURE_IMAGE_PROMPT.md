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
SUBTITLE: "Roll back by moving the 'live' alias to an existing version and restoring $LATEST.
No rebuild — the package Lambda already stores is reused."

LAYOUT (left to right):
Column 1 (far left): a box labelled "GitHub" containing a repository icon labelled
"service-lambda-rollback repo" and three GitHub Actions workflow boxes stacked vertically:
  - "Deploy — on push to main — cdk deploy"
  - "Deploy branch — manual, choose branch — cdk deploy"
  - "Rollback — manual — inputs: target_version, dry_run"
Next to the workflows, a small key icon labelled "Secrets: AWS_ACCESS_KEY_ID,
AWS_SECRET_ACCESS_KEY, AWS_REGION".

Columns 2–4: a large box labelled "AWS account / region", containing a CloudFormation icon
at the top labelled "CloudFormation stack: ServiceLambdaStack (AWS CDK)" with a thin dashed line
indicating it creates every resource in the box.

Inside the AWS box, three group boxes:

GROUP A — "Service" (left part of the AWS box):
  - A small "Callers" icon (generic client) outside the group, on its left edge, with two arrows:
      solid arrow labelled "invoke service-lambda:live" to the alias,
      dashed arrow labelled "invoke unqualified (console Test)" to $LATEST.
  - A Lambda icon labelled "service-lambda (Node.js 22)".
  - Under it, a horizontal row of small version tiles: "v1", "v2", "v3 … vN", each with a tiny
    caption "description: <commit hash + message>". Caption the row "Published versions
    (immutable, retained)".
  - A tag/pointer shape labelled "Alias: live" pointing to one of the version tiles (e.g. "v3"),
    with a small note "alias description: 'deployed <commit>' or 'auto-rollback #N from vX at <time>'".
  - A separate tile labelled "$LATEST (unpublished code)".

GROUP B — "Detection" (middle of the AWS box):
  - A CloudWatch Metrics icon labelled "AWS/Lambda Errors" with three small metric lines labelled
    "Resource = service-lambda:live", "Resource = service-lambda", "Resource = service-lambda:$LATEST".
    Arrows from the alias "live" and from "$LATEST" into these metrics.
  - A CloudWatch Alarm icon labelled "Alarm: service-lambda-errors" with caption
    "FILL(live,0) + FILL(unqualified,0) + FILL(latest,0) ≥ 1 in 1 minute".
  - An SNS icon labelled "SNS topic: service-lambda-rollback-notifications".
    Arrow from the alarm to SNS labelled "on OK → ALARM".
  - An EventBridge icon labelled "EventBridge rule (default bus): service-lambda-rollback-check"
    with caption "rate(5 minutes)".

GROUP C — "Rollback" (right part of the AWS box):
  - A Lambda icon labelled "service-lambda-rollback".
  - Attached to it, a small document icon labelled "config.json — registered functions, their
    alarms, enabled flag, maxConsecutiveRollbacks".
  - Inside or directly below the rollback Lambda, a small numbered checklist box labelled
    "Pre-hook":
      "1. Function registered & enabled in config.json?"
      "2. Alarm registered for that function?"
      "3. Cooldown (3 min) passed and under max consecutive rollbacks?"
  - An STS icon labelled "STS AssumeRole + session policy (scoped to one function)".
  - An IAM role icon labelled "RollbackExecutionRole — upper bound: registered functions only".
  - An S3 icon (small, dashed outline) labelled "Lambda-managed package storage
    (pre-signed URL)".
  - A CloudWatch Logs icon labelled "Rollback logs".

ARROWS (number them with small circled numbers so the flow can be followed):
  (1) GitHub "Deploy" and "Deploy branch" → CloudFormation: "cdk deploy (publishes new version,
      moves live)".
  (2) Alias "live" / "$LATEST" → CloudWatch Errors metrics: "errors".
  (3) Metrics → Alarm.
  (4) Alarm → SNS: "on OK → ALARM".
  (5) SNS → service-lambda-rollback: "alarm message".
  (6) EventBridge → service-lambda-rollback: "every 5 min: scheduled-check".
  (7) service-lambda-rollback → CloudWatch Alarm (dashed): "DescribeAlarms — still in ALARM?".
  (8) service-lambda-rollback → config.json (dashed): "read registrations".
  (9) service-lambda-rollback → STS → RollbackExecutionRole: "AssumeRole, scoped credentials".
  (10) service-lambda-rollback → Alias "live" (thick, red/orange): "UpdateAlias → previous version".
  (11) service-lambda-rollback → S3 package storage → $LATEST (thick, red/orange):
       "GetFunction + download package → UpdateFunctionCode ($LATEST, no publish)".
  (12) service-lambda-rollback → CloudWatch Logs: "logs".
  (13) GitHub "Rollback" workflow → Alias "live" and → $LATEST (thick, purple, dashed):
       "manual rollback: UpdateAlias + restore $LATEST (dry run: list versions only)".

COLOURS:
  - Normal deploy and data flow arrows: dark grey.
  - Automatic rollback actions (10, 11): orange-red.
  - Manual rollback (13): purple.
  - Group boxes: very light tints (Service: light blue, Detection: light pink,
    Rollback: light orange). GitHub box: light grey.

LEGEND (bottom right):
  "Solid grey = deploy / data flow", "Orange-red = automatic rollback",
  "Purple dashed = manual rollback (GitHub Actions)", "Dashed thin = read-only call".

FOOTER NOTE (bottom left, small text):
  "Rollback never rebuilds. It points 'live' at an already-published version and re-uploads that
  version's stored package as $LATEST. Next deploy resets the alias description and rollback count."

Do not add services that are not listed. Do not draw VPCs, API Gateway, databases or load balancers.
```

---

## Short prompt

```text
AWS architecture diagram, official AWS icons, white background, left-to-right, labelled arrows, 16:9.
Left: GitHub box with workflows "Deploy (push to main)", "Deploy branch (manual)", "Rollback (manual,
dry_run)". Right: "AWS account" box created by "CloudFormation: ServiceLambdaStack (CDK)".
Inside: Lambda "service-lambda" with version tiles v1…vN, alias "live" pointing at one version, and
"$LATEST". CloudWatch "Errors" metrics for live and $LATEST → CloudWatch Alarm "service-lambda-errors"
(≥1 error/min) → SNS "service-lambda-rollback-notifications" → Lambda "service-lambda-rollback".
EventBridge rule "service-lambda-rollback-check, rate(5 minutes)" → same rollback Lambda.
Rollback Lambda reads "config.json" (pre-hook: registered function + alarm, cooldown, max rollbacks),
calls STS AssumeRole for scoped credentials, then (orange arrows) "UpdateAlias live → previous version"
and "download stored package → UpdateFunctionCode $LATEST". GitHub "Rollback" workflow does the same
manually (purple dashed arrow). Legend: grey = deploy, orange = automatic rollback, purple = manual.
No VPC, API Gateway or databases.
```

---

## Reference

What actually exists in this repository, to check the generated image against.

### Components

| Component | Name | Defined in |
|---|---|---|
| GitHub Actions workflow | `Deploy` (push to `main`, `cdk deploy`) | `.github/workflows/deploy.yml` |
| GitHub Actions workflow | `Deploy branch` (manual, `branch` input) | `.github/workflows/deploy-branch.yml` |
| GitHub Actions workflow | `Rollback` (manual, `target_version`, `dry_run`) | `.github/workflows/rollback.yml` |
| CloudFormation stack (CDK) | `ServiceLambdaStack` | `bin/app.ts`, `lib/service-stack.ts` |
| Lambda function | `service-lambda` (logs its version) | `lambda/index.mjs` |
| Lambda versions | published per code/config change, retained, description = last commit touching `lambda/` | `lib/service-stack.ts` |
| Lambda alias | `live` | `lib/service-stack.ts` |
| CloudWatch alarm | `service-lambda-errors` (metric math over `live`, unqualified and `$LATEST` errors, ≥ 1 in 1 min) | `lib/service-stack.ts` |
| SNS topic | `service-lambda-rollback-notifications` | `lib/service-stack.ts` |
| EventBridge rule (default bus) | `service-lambda-rollback-check`, `rate(5 minutes)` | `lib/service-stack.ts` |
| Lambda function | `service-lambda-rollback` | `lambda-rollback/index.mjs` |
| Config | registered functions, alarms, `enabled`, `maxConsecutiveRollbacks` | `lambda-rollback/config.json` |
| IAM role | `RollbackExecutionRole` (Lambda permissions for registered functions only) | `lib/service-stack.ts` |
| STS | `AssumeRole` with a session policy scoped to the one function being rolled back | `lambda-rollback/index.mjs` |

### Flows

1. **Deploy:** GitHub Actions runs `cdk deploy`, which publishes a new version (with a commit description) and moves `live` to it. The alias description is reset to `deployed <commit>`.
2. **Detect:** errors from `service-lambda:live` or `$LATEST` raise `service-lambda-errors` to `ALARM`.
3. **Notify:** the alarm publishes to the SNS topic on `OK → ALARM`, which invokes `service-lambda-rollback`.
4. **Re-check:** every 5 minutes EventBridge invokes `service-lambda-rollback`, which reads the registered alarms (`DescribeAlarms`) and treats any still in `ALARM` as if it had just fired.
5. **Pre-hook:** the function must be registered and enabled in `config.json`, the alarm must be registered for it, the 3-minute cooldown must have passed and the consecutive-rollback limit must not be reached.
6. **Scoped credentials:** STS `AssumeRole` on `RollbackExecutionRole`, with a session policy limited to that one function.
7. **Roll back the alias:** `UpdateAlias live` → highest version below the current one; alias description becomes `auto-rollback #N from vX at <time>`.
8. **Restore `$LATEST`:** `GetFunction` on the target version → download its stored package → `UpdateFunctionCode` on `$LATEST` (no publish) → verify the code hash.
9. **Manual rollback:** the `Rollback` workflow does steps 7–8 with the AWS CLI. With `dry_run` it only lists versions (with descriptions) and what it would do. It marks the alias `manual-rollback from vX at <time>`.
