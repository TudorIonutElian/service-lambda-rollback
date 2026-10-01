# Rollback system cost estimate

Estimated monthly cost of the automatic rollback system with **500 registered Lambda functions**.

> Estimates use AWS list prices for us-east-1 (standard-resolution alarms, x86 Lambda) and were not
> re-checked against the current price list. Confirm with the
> [AWS Pricing Calculator](https://calculator.aws/) before relying on them.

## Assumptions

- Each registered function has one errors alarm, as `service-lambda` does today: a metric-math alarm over
  3 metrics (`<fn>:live`, unqualified `<fn>`, `<fn>:$LATEST`).
- The EventBridge check runs every 5 minutes (`ROLLBACK_CHECK_INTERVAL_MINUTES`).
- A scheduled check takes ~1 s at 128 MB; actual rollbacks are rare (a few per month).
- The cost of the monitored functions themselves (invocations, their own logs) is not included.

## Monthly cost

| Item | Usage | ~ Monthly cost |
|---|---|---|
| **CloudWatch alarms** | 500 alarms × 3 metrics each, billed per metric at ~$0.10 | **~$150** |
| Rollback function, scheduled runs | every 5 min ≈ 8,640 runs, ~1 s at 128 MB | < $0.05, likely within the free tier |
| Rollback function, actual rollbacks | a few per month | ~$0 |
| EventBridge scheduled rule | 8,640 runs | free |
| SNS → Lambda | alarm notifications | ~$0 |
| STS temporary credentials | per rollback | free |
| CloudWatch Logs | each check logs one line per alarm (~4M lines, ~0.3 GB) | ~$0.20 |
| Reading alarms (DescribeAlarms calls) | a few per run | ~$0, within the free tier |
| Lambda error metrics | sent by AWS automatically | free |
| **Total** | | **≈ $150/month** |

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
| Rollback function timeout is 2 minutes | Rollbacks in one run happen one after another, each downloading and uploading a package; many alarms firing at once could time out | Handle each alarm in its own invocation, e.g. one SNS/SQS message per alarm |
