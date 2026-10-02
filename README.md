# service-lambda-rollback

An AWS CDK app with a Lambda function (`service-lambda`) and a rollback system for it, both automatic
and manual. Every published version is archived: its metadata in DynamoDB and its package in S3 as
`<function>-<version>.zip`. A rollback never rebuilds anything: it points the `live` alias at an
archived version and restores `$LATEST` from that version's zip.

![Architecture](docs/arch-diagram.png)

## How it works

### Deploy

Every deploy that changes the function's code or configuration publishes a new, immutable version and
moves the `live` alias to it. Old versions are kept. Each version's description is the last commit
that touched `lambda/`. After `cdk deploy`, the deploy workflows invoke the rollback function's sync
step so the new version is archived straight away.

### Sync / archive

For every registered function, the sync step:

1. Lists the function's published versions and archives each one not seen before: copies its package
   to `s3://service-lambda-rollback-artifacts-<account>-<region>/<fn>/<fn>-<version>.zip` and writes its
   metadata to the DynamoDB table `service-lambda-rollback-versions`.
2. Compares the alias with the table's `CURRENT` record. If the alias was moved outside the rollback
   system (a deploy), it records the new version with the current time and resets the
   consecutive-rollback count.

Sync runs after every deploy, on every scheduled check and before every rollback.

### Automatic rollback

1. The CloudWatch alarm `service-lambda-errors` fires when there is at least 1 error in a minute on
   `service-lambda:live` or `$LATEST`.
2. The alarm publishes to the SNS topic `service-lambda-rollback-notifications`, which invokes
   `service-lambda-rollback`.
3. **Pre-hook:** the function must be registered and enabled in `lambda-rollback/config.json`, and the
   alarm must be registered for it.
4. The rollback function gets temporary credentials scoped to that single function: its alias and
   versions, its S3 folder and its DynamoDB items (STS `AssumeRole` with a session policy).
5. It syncs, then applies the [rollback guards](#rollback-guards).
6. It moves `live` to the previous archived version, restores `$LATEST` from that version's zip in S3,
   and records the rollback in DynamoDB.

### $LATEST-only failures

If new code reaches `$LATEST` without a version being published or the alias being moved, calls to
the bare function can fail while `live` is fine. Before rolling back the alias, the rollback function
checks for this:

1. It compares `$LATEST`'s code hash with the live version's archived code hash.
2. If they differ, it reads the alias's own `Errors` metric for the last 5 minutes
   (`LIVE_ERRORS_LOOKBACK_MINUTES`).
3. If the alias had no errors, only `$LATEST` is failing: it restores `$LATEST` from the live
   version's zip in S3 and leaves the alias where it is. If the alias also had errors, it does a normal
   alias rollback (which restores `$LATEST` too).

A `$LATEST`-only revert uses the same deployment window, measured from `$LATEST`'s last code change,
and starts the cooldown, so the alarm can clear before anything else happens. It doesn't count towards
`maxConsecutiveRollbacks`. It is recorded on `CURRENT` as `lastLatestRevertAt`,
`latestRevertedFromSha`, `latestRevertedToVersion` and `latestRevertReason`.

### Rollback guards

An automatic rollback is skipped, with a log line saying why, when any of these applies:

| Guard | Rule | Configured by |
|---|---|---|
| Not registered | The function isn't in `config.json`, is `"enabled": false`, or the alarm isn't one of its `alarms` | `config.json` |
| Deployment window | No deploy or rollback was recorded in the last N minutes, so the alarm isn't blamed on a change | `deploymentWindowMinutes` (default 10), per function or general |
| Cooldown | The last rollback was less than 3 minutes ago, so the alarm hasn't judged that version yet | `ROLLBACK_COOLDOWN_MINUTES` |
| Limit | The function has already been rolled back N times in a row since the last deploy | `maxConsecutiveRollbacks` (default 2), per function or general |
| Nothing to roll back to | There is no archived version older than the live one | — |

The deployment window is measured from `CURRENT.updatedAt`: the time of the last rollback, or the time
sync recorded the last deploy (right after the deploy workflows, or at the latest on the next scheduled
check).

### Scheduled check

The EventBridge rule `service-lambda-rollback-check` invokes the rollback function every 5 minutes.
Each run:

1. **Syncs** every registered function.
2. **Marks stable versions:** if all of a function's registered alarms are `OK` and its live version
   has been live for at least 5 minutes, that version gets `stable: true` and `stableAt`, on both the
   `CURRENT` item and the version's own item. A version that is later rolled back from gets
   `stable: false`, plus how long it had been stable: `stableForSeconds` (from `stableAt` to the
   rollback) and `stableFor` as readable text, e.g. `2h 30m`. If it was never marked stable while
   live, `stableForSeconds` is `0` and `stableFor` is `not marked stable while live`. This is set by
   automatic and manual rollbacks alike.
3. **Re-checks alarms:** CloudWatch only notifies when an alarm changes state. If the version rolled
   back to also fails, the alarm stays in `ALARM` and no new notification comes. Any registered alarm
   still in `ALARM` is handled as if it had just fired, subject to the same guards.

### Manual rollback

Two GitHub Actions workflows roll back by hand:

- **`Rollback by version`:** leave `target_version` empty to go back one version, or enter a
  specific version.
- **`Rollback to commit`:** pick one of the last 5 deployed commits from a dropdown, e.g.
  `v7 · abc1234 Fix greeting` (the Lambda version, then the commit it was built from). It resolves
  the choice to that version and runs `Rollback by version` with it.

Both:

1. Stop straight away if a `Deploy` or `Deploy branch` run is running or queued. A dry run only warns.
2. Sync.
3. Move `live` back and restore `$LATEST` from S3 with the AWS CLI, and record the rollback in
   DynamoDB. A manual rollback starts the cooldown but doesn't count towards the consecutive-rollback
   limit, and isn't limited by the deployment window.

Tick `dry_run` to only list the archived versions (commit description, code hash, S3 key, whether it
was rolled back) and see what would happen.

#### The commit dropdown

GitHub can't fill a dropdown at run time: a `choice` input's options must be written in the workflow
file. So after every deploy to `main`, the `Deploy` workflow's `update-commit-dropdown` job reads
the last 5 archived versions from DynamoDB, rewrites the options between the
`# BEGIN/END generated commit options` markers in `.github/workflows/rollback-to-commit.yml`, and
pushes the change to `main`. That commit is marked `[skip ci]` and the file is in `paths-ignore`,
so it doesn't start another deploy.

Pushing a change to a workflow file needs a token with `workflow` scope; the built-in
`GITHUB_TOKEN` isn't allowed to. Add one as the `WORKFLOW_PAT` secret (a fine-grained token with
**Contents** and **Workflows** read/write on this repository). Without it, the job only warns and the
dropdown keeps its previous options. If `main` is protected, the token's owner must be allowed to
push to it.

## Version metadata (DynamoDB)

Table `service-lambda-rollback-versions`, partition key `functionName`, sort key `sk`:

| `sk` | Attributes |
|---|---|
| `VERSION#0000000003` | `version`, `codeSha256`, `description`, `lastModified`, `runtime`, `handler`, `memorySize`, `timeout`, `codeSize`, `s3Bucket`, `s3Key`, `archivedAt`; once its alarms stayed OK while live: `stable`, `stableAt`; after a rollback away from it: `rolledBackAt`, `rolledBackBy`, `rollbackReason`, `stable: false`, `stableForSeconds`, `stableFor` |
| `CURRENT` | `version` the alias points to, `previousVersion`, `updatedBy` (`deploy` / `auto-rollback` / `manual-rollback`), `updatedAt`, `lastRollbackAt`, `rollbackCount`, `stable`, `stableAt`; after a `$LATEST`-only revert: `lastLatestRevertAt`, `latestRevertedFromSha`, `latestRevertedToVersion`, `latestRevertReason` |

The S3 bucket and the table are kept if the stack is deleted (`RemovalPolicy.RETAIN`).

## Registering a function for automatic rollback

Edit `lambda-rollback/config.json` and deploy:

```json
{
  "maxConsecutiveRollbacks": 2,
  "deploymentWindowMinutes": 10,
  "functions": [
    { "name": "service-lambda", "enabled": true, "alias": "live", "alarms": ["service-lambda-errors"] },
    { "name": "other-lambda", "alarms": ["other-lambda-errors"], "maxConsecutiveRollbacks": 3, "deploymentWindowMinutes": 30 }
  ]
}
```

| Field | Where | Default | Meaning |
|---|---|---|---|
| `maxConsecutiveRollbacks` | top level | `2` | Automatic rollbacks in a row before giving up, for functions that don't set their own. The count resets on the next deploy |
| `deploymentWindowMinutes` | top level | `10` | Automatic rollback only happens if a deploy or rollback happened within this many minutes, for functions that don't set their own |
| `name` | function | required | Lambda function name |
| `alarms` | function | `[]` | Alarms allowed to trigger this function's rollback |
| `alias` | function | `live` | Alias to roll back |
| `enabled` | function | `true` | `false` deregisters the function without removing the entry |
| `maxConsecutiveRollbacks` | function | top-level value | This function's own limit; `0` turns off automatic rollback but keeps the archive and manual rollback |
| `deploymentWindowMinutes` | function | top-level value | This function's own deployment window |

- **Register:** add an entry with the function name, its alias (default `live`) and the alarms
  allowed to trigger its rollback.
- **Deregister:** set `"enabled": false`, or remove the entry. Its archived versions stay in S3 and
  DynamoDB.

The function must publish versions, have the alias, and be packaged as a zip (container images are
not supported). Its alarm must send to `service-lambda-rollback-notifications`. Permissions, the
scheduled check and the sync are generated from this file.

## Settings in the stack

System-wide settings live as constants in `lib/service-stack.ts`:

| Constant | Default | Meaning |
|---|---|---|
| `ROLLBACK_CHECK_INTERVAL_MINUTES` | `5` | How often the scheduled check runs |
| `ROLLBACK_COOLDOWN_MINUTES` | `3` | Minimum time between two rollbacks of the same function |
| `STABLE_AFTER_MINUTES` | `5` | How long a version must be live, with all its alarms OK, before it is marked stable |
| `LIVE_ERRORS_LOOKBACK_MINUTES` | `5` | How far back to look for errors on the alias when deciding whether only `$LATEST` is failing |

## Rollback function invocations

`service-lambda-rollback` logs every input event (`Event: …`) in the log group
`/aws/lambda/service-lambda-rollback`. It accepts:

| Event | Sent by | What it does |
|---|---|---|
| SNS record with a CloudWatch alarm message | the alarm, via `service-lambda-rollback-notifications` | Automatic rollback for the alarm's function |
| `{ "type": "scheduled-check" }` | EventBridge rule `service-lambda-rollback-check` | Sync, mark stable versions, re-check alarms |
| `{ "type": "sync" }` | deploy workflows | Sync all registered functions |
| `{ "type": "sync", "functionName": "<fn>" }` | `Rollback by version` / `Rollback to commit` | Sync one function |

## Repository layout

| Path | Contents |
|---|---|
| `bin/app.ts` | CDK app entry point |
| `lib/service-stack.ts` | The stack: `service-lambda`, alias, alarm, SNS topic, EventBridge rule, DynamoDB table, S3 bucket, rollback function, IAM |
| `lambda/` | `service-lambda` code (logs the version it runs as) |
| `lambda-rollback/index.mjs` | Rollback function: sync/archive, stable marking, alarm handling, rollback |
| `lambda-rollback/config.json` | Functions registered for automatic rollback |
| `.github/workflows/` | `Deploy`, `Deploy branch`, `Rollback by version` (`rollback-by-version.yml`), `Rollback to commit` (`rollback-to-commit.yml`) |
| `docs/` | Cost estimate, architecture diagram and the prompt used to generate it |

## Workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `Deploy` | Push to `main` (except `.md` / `docs/` / `rollback-to-commit.yml` only changes), or manual | `cdk deploy`, then sync, then refresh the `Rollback to commit` dropdown |
| `Deploy branch` | Manual, choose a branch | `cdk deploy` from that branch, then sync |
| `Rollback by version` | Manual, inputs `target_version` and `dry_run` | Stops if a deploy is running or queued; otherwise syncs, moves `live` back and restores `$LATEST` from S3. Dry run only lists versions |
| `Rollback to commit` | Manual, inputs `commit` (dropdown of the last 5 deployed commits) and `dry_run` | Resolves the commit to its Lambda version, then runs `Rollback by version` |

GitHub repository secrets:

| Secret | Used by | Required |
|---|---|---|
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | all workflows | yes |
| `WORKFLOW_PAT` | `Deploy` (refreshing the commit dropdown) | no; without it the dropdown isn't refreshed |

When running `Deploy branch` or a rollback workflow to test a branch, pick that branch under
**Use workflow from**, so the branch's version of the workflow runs. The `Rollback to commit` dropdown
on a branch shows the options last committed to that branch.

## Setup

```sh
npm ci
npx cdk bootstrap   # once per account/region
npx cdk deploy
```

## Testing an automatic rollback

1. Deploy a good version, then a version whose handler throws (e.g. `throw new Error('boom')` in
   `lambda/index.mjs`).
2. Within the deployment window (10 minutes by default), invoke `service-lambda:live` a few times.
3. Within 1–3 minutes the alarm fires and `live` moves back. The `CURRENT` item shows
   `updatedBy: auto-rollback`, and the bad version's item gets `rolledBackBy`.
4. Once the alarm is `OK` again and 5 minutes have passed, the next scheduled check marks the live
   version `stable`.

## Things to know

- Call the function through its alias (`service-lambda:live`). The rollback also restores `$LATEST`'s
  code, but not its configuration.
- After a rollback, `$LATEST` no longer matches git until the next deploy that changes `lambda/`.
- A failure that starts long after a deploy (e.g. a downstream outage) doesn't trigger a rollback,
  because of the deployment window.
- Only versions that have been synced can be rolled back to. Sync runs after deploys, on every
  scheduled check and before each rollback, so this only matters for versions deleted from Lambda
  before a sync.

## More docs

- [Cost estimate for 500 functions](docs/COSTS.md)
- [Architecture diagram prompt](docs/ARCHITECTURE_IMAGE_PROMPT.md)
