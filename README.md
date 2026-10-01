# service-lambda-rollback

An AWS CDK app with a Lambda function (`service-lambda`) and a rollback system for it, both automatic
and manual. Every published version is archived: its metadata in DynamoDB and its package in S3 as
`<function>-<version>.zip`. A rollback never rebuilds anything: it points the `live` alias at an
archived version and restores `$LATEST` from that version's zip.

![Architecture](docs/arch-diagram.png)

## How it works

**Deploy.** Every deploy that changes the function's code or configuration publishes a new, immutable
version and moves the `live` alias to it. Old versions are kept. Each version's description is the
last commit that touched `lambda/`. After `cdk deploy`, the deploy workflows call the rollback
function's sync step so the new version is archived straight away.

**Sync / archive.** For every registered function, the sync step:

1. Lists the function's published versions and archives each one not seen before: copies its package
   to `s3://service-lambda-rollback-artifacts-<account>-<region>/<fn>/<fn>-<version>.zip` and writes its
   metadata to the DynamoDB table `service-lambda-rollback-versions`.
2. Compares the alias with the table's `CURRENT` record. If the alias was moved outside the rollback
   system (a deploy), it records the new version and resets the consecutive-rollback count.

Sync runs after every deploy, every 5 minutes (scheduled check) and before every rollback.

**Automatic rollback.**

1. The CloudWatch alarm `service-lambda-errors` fires when there is at least 1 error in a minute on
   `service-lambda:live` or `$LATEST`.
2. The alarm publishes to the SNS topic `service-lambda-rollback-notifications`, which invokes
   `service-lambda-rollback`.
3. A pre-hook checks `lambda-rollback/config.json`: the function must be registered and enabled, and
   the alarm must be registered for it.
4. The rollback function gets temporary credentials scoped to that single function: its alias and
   versions, its S3 folder and its DynamoDB items (STS `AssumeRole` with a session policy).
5. It syncs, then checks the 3-minute cooldown and the consecutive-rollback limit from the `CURRENT`
   record.
6. It moves `live` to the previous archived version, restores `$LATEST` from that version's zip in S3,
   and records the rollback in DynamoDB.

CloudWatch only notifies when an alarm changes state. If the version rolled back to also fails, the
alarm stays in `ALARM`, so the EventBridge rule `service-lambda-rollback-check` re-checks registered
alarms every 5 minutes and rolls back again if needed.

**Manual rollback.** The `Rollback` GitHub Actions workflow syncs, then does the same with the AWS CLI.
Leave `target_version` empty to go back one version, or enter a specific version. Tick `dry_run` to
only list the archived versions (commit description, code hash, S3 key, whether it was rolled back)
and see what would happen.

## Version metadata (DynamoDB)

Table `service-lambda-rollback-versions`, partition key `functionName`, sort key `sk`:

| `sk` | Attributes |
|---|---|
| `VERSION#0000000003` | `version`, `codeSha256`, `description`, `lastModified`, `runtime`, `handler`, `memorySize`, `timeout`, `codeSize`, `s3Bucket`, `s3Key`, `archivedAt`; after a rollback away from it: `rolledBackAt`, `rolledBackBy`, `rollbackReason` |
| `CURRENT` | `version` the alias points to, `previousVersion`, `updatedBy` (`deploy` / `auto-rollback` / `manual-rollback`), `updatedAt`, `lastRollbackAt`, `rollbackCount` |

The S3 bucket and the table are kept if the stack is deleted (`RemovalPolicy.RETAIN`).

## Repository layout

| Path | Contents |
|---|---|
| `bin/app.ts` | CDK app entry point |
| `lib/service-stack.ts` | The stack: `service-lambda`, alias, alarm, SNS topic, EventBridge rule, DynamoDB table, S3 bucket, rollback function, IAM |
| `lambda/` | `service-lambda` code (logs the version it runs as) |
| `lambda-rollback/index.mjs` | Rollback function: sync/archive, alarm handling, rollback |
| `lambda-rollback/config.json` | Functions registered for automatic rollback |
| `.github/workflows/` | `Deploy`, `Deploy branch`, `Rollback` |
| `docs/` | Cost estimate, architecture diagram and the prompt used to generate it |

## Workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `Deploy` | Push to `main` (except `.md` / `docs/` only changes), or manual | `cdk deploy`, then sync |
| `Deploy branch` | Manual, choose a branch | `cdk deploy` from that branch, then sync |
| `Rollback` | Manual, inputs `target_version` and `dry_run` | Sync, then move `live` back and restore `$LATEST` from S3; dry run only lists versions |

All three need these GitHub repository secrets: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_REGION`.

## Registering a function for automatic rollback

Edit `lambda-rollback/config.json` and deploy:

```json
{
  "maxConsecutiveRollbacks": 2,
  "functions": [
    { "name": "service-lambda", "enabled": true, "alias": "live", "alarms": ["service-lambda-errors"] }
  ]
}
```

- **Register:** add an entry with the function name, its alias (default `live`) and the alarms
  allowed to trigger its rollback.
- **Deregister:** set `"enabled": false`, or remove the entry. Its archived versions stay in S3 and
  DynamoDB.

The function must publish versions, have the alias, and be packaged as a zip (container images are
not supported). Its alarm must send to `service-lambda-rollback-notifications`. Permissions, the
scheduled check and the sync are generated from this file.

## Setup

```sh
npm ci
npx cdk bootstrap   # once per account/region
npx cdk deploy
```

## Things to know

- Call the function through its alias (`service-lambda:live`). The rollback also restores `$LATEST`'s
  code, but not its configuration.
- After a rollback, `$LATEST` no longer matches git until the next deploy that changes `lambda/`.
- Only versions that have been synced can be rolled back to. Sync runs after deploys, every 5 minutes
  and before each rollback, so this only matters for versions deleted from Lambda before a sync.

## More docs

- [Cost estimate for 500 functions](docs/COSTS.md)
- [Architecture diagram prompt](docs/ARCHITECTURE_IMAGE_PROMPT.md)
