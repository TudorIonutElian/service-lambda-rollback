# Rollback system cost estimate

Estimated monthly cost of the automatic rollback system with **500 registered Lambda functions**.

> Estimates use AWS list prices for us-east-1 (standard-resolution alarms, x86 Lambda) and were not
> re-checked against the current price list. Confirm with the
> [AWS Pricing Calculator](https://calculator.aws/) before relying on them.

## Assumptions

- Each registered function has one errors alarm, as `service-lambda` does today: a metric-math alarm over
  3 metrics (`<fn>:live`, unqualified `<fn>`, `<fn>:$LATEST`).
- The EventBridge check runs every 5 minutes (`ROLLBACK_CHECK_INTERVAL_MINUTES`).
- Every scheduled check also syncs all registered functions (~5 API calls each when nothing is new),
  so a run over 500 functions takes ~100 s at 512 MB. Actual rollbacks are rare (a few per month).
- Each function keeps ~20 archived versions of ~5 MB in S3 (50 GB in total), and deploys ~once a day.
- The cost of the monitored functions themselves (invocations, their own logs) is not included.

## Monthly cost

| Item | Usage | ~ Monthly cost |
|---|---|---|
| **CloudWatch alarms** | 500 alarms × 3 metrics each, billed per metric at ~$0.10 | **~$150** |
| Rollback function, scheduled runs | every 5 min ≈ 8,640 runs, ~100 s at 512 MB (sync of 500 functions) | ~$7 |
| Rollback function, actual rollbacks | a few per month | ~$0 |
| EventBridge scheduled rule | 8,640 runs | free |
| SNS → Lambda | alarm notifications | ~$0 |
| STS temporary credentials | one per function per sync (~4.3M/month) | free |
| DynamoDB (on demand) | ~1,000 consistent reads per run (~8.6M/month); writes only for new versions and rollbacks | ~$1–2 |
| S3 storage | 500 functions × ~20 versions × ~5 MB ≈ 50 GB | ~$1.15 |
| S3 requests | one PUT per new version (~15k/month); GETs only on rollback | < $0.10 |
| CloudWatch Logs | each check logs a few lines per function and alarm (~15M lines, ~1.5 GB) | ~$0.75 |
| Reading alarms (DescribeAlarms calls) | a few per run | ~$0, within the free tier |
| Lambda error metrics | sent by AWS automatically | free |
| **Total** | | **≈ $160/month** |

### Cheaper option

Alarm on `<fn>:live` only, instead of `live` + `$LATEST`: 1 metric per alarm, about **$50/month** for 500 functions.
Errors from unqualified / `$LATEST` calls would then no longer trigger a rollback.

## Limits to fix before scaling to 500

These are not costs, but they would break the current code well before 500 functions.

| Limit | Why it breaks | Fix |
|---|---|---|
| Reading alarms (`DescribeAlarms`) accepts at most 100 names per call | The scheduled check passes all registered alarm names in one call | Ask only for alarms in `ALARM` (`StateValue=ALARM`, paginated), then keep the registered ones |
| IAM caps inline policies at 10,240 characters per role | The rollback role lists 2 ARNs per function, and the alarm-reading permission lists every alarm; deploy fails at roughly 60–80 functions | Grant by tag (e.g. `rollback-enabled=true`) or by a naming pattern (e.g. `function:svc-*`); the per-rollback session policy still narrows each run to one function |
| Lambda code storage quota is 75 GB per region by default | Every published version is kept (`RemovalPolicy.RETAIN`) | Keep only the last N versions per function (e.g. 10), deleting older ones after deploy |
| Rollback function timeout is 2 minutes | Each scheduled run syncs every registered function one after another (~100 s for 500), then handles alarms; rollbacks also run one after another | Fan out: one invocation (or SQS message) per function for sync and per alarm for rollback, or sync in parallel batches |
| IAM caps inline policies at 10,240 characters per role (S3 / DynamoDB too) | The rollback role also lists one S3 prefix and one DynamoDB leading key per function | Same fix as above: grant by tag or naming pattern; the session policy still scopes each run to one function |
