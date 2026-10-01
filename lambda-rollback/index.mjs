// Invoked by SNS when a CloudWatch alarm goes into ALARM, and every few minutes by an
// EventBridge schedule that re-checks alarms still in ALARM (CloudWatch only notifies on
// state changes, so a rolled-back version that also fails would otherwise never trigger).
// Moves the alias back to the previous published version and puts that version's
// package back into $LATEST. No build: the package is the one Lambda already stores.
import {
  LambdaClient,
  GetAliasCommand,
  GetFunctionCommand,
  UpdateAliasCommand,
  UpdateFunctionCodeCommand,
  paginateListVersionsByFunction,
  waitUntilFunctionUpdatedV2,
} from '@aws-sdk/client-lambda';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import config from './config.json' with { type: 'json' };

const sts = new STSClient({});
const cloudwatch = new CloudWatchClient({});
const DEFAULT_ALIAS = process.env.DEFAULT_ALIAS ?? 'live';
const ROLLBACK_ROLE_ARN = process.env.ROLLBACK_ROLE_ARN;
// e.g. arn:aws:lambda:eu-central-1:123456789012:function:
const FUNCTION_ARN_PREFIX = process.env.FUNCTION_ARN_PREFIX;
// Only functions listed here are plugged into automatic rollback.
const ENABLED_FUNCTIONS = new Set(config.enabledFunctions ?? []);
// Automatic rollbacks in a row before giving up; the count resets on the next deploy.
const MAX_CONSECUTIVE_ROLLBACKS = config.maxConsecutiveRollbacks ?? 2;
// Time the alarm gets to evaluate a version after a rollback, before another one may happen.
const COOLDOWN_MS = Number(process.env.ROLLBACK_COOLDOWN_MINUTES ?? 3) * 60_000;

// The alias description records the last rollback, e.g. "auto-rollback #1 from v3 at 2026-10-01T16:00:00.000Z".
// A deploy replaces it, which resets the count.
const ROLLBACK_MARKER = /^(auto|manual)-rollback(?: #(\d+))? from v\d+ at (\S+)$/;

export const handler = async (event) => {
  if (event.type === 'scheduled-check') {
    return checkAlarms(event.alarmNames ?? []);
  }

  const results = [];
  for (const record of event.Records ?? []) {
    const alarm = JSON.parse(record.Sns.Message);
    results.push(await handleAlarm(alarm));
  }
  return results;
};

// Scheduled re-check: treat every listed alarm still in ALARM as if it had just fired.
async function checkAlarms(alarmNames) {
  if (alarmNames.length === 0) return [];
  const { MetricAlarms = [] } = await cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: alarmNames }));
  const results = [];
  for (const alarm of MetricAlarms) {
    console.log(`Scheduled check: alarm '${alarm.AlarmName}' is ${alarm.StateValue}`);
    if (alarm.StateValue !== 'ALARM') {
      results.push(skip(`alarm '${alarm.AlarmName}' is ${alarm.StateValue}`));
      continue;
    }
    results.push(await handleAlarm({
      AlarmName: alarm.AlarmName,
      NewStateValue: alarm.StateValue,
      Trigger: { Dimensions: alarm.Dimensions, Metrics: alarm.Metrics },
    }));
  }
  return results;
}

async function handleAlarm(alarm) {
  console.log(`Alarm '${alarm.AlarmName}' state: ${alarm.NewStateValue}`);
  if (alarm.NewStateValue !== 'ALARM') {
    return skip(`state is ${alarm.NewStateValue}, not ALARM`);
  }

  const target = targetFromAlarm(alarm);
  if (!target) {
    return skip('alarm has no FunctionName dimension');
  }
  const { functionName, aliasName } = target;

  const lambda = await preHook(functionName);
  if (!lambda) {
    return skip(`${functionName} is not enabled for rollback (see config.json)`);
  }

  const alias = await lambda.send(new GetAliasCommand({ FunctionName: functionName, Name: aliasName }));
  const currentVersion = Number(alias.FunctionVersion);

  const last = lastRollback(alias.Description);
  if (last) {
    const sinceMs = Date.now() - last.at.getTime();
    if (sinceMs < COOLDOWN_MS) {
      return skip(`${functionName}:${aliasName} was rolled back ${Math.round(sinceMs / 1000)}s ago, giving the alarm time to evaluate version ${currentVersion}`);
    }
    if (last.count >= MAX_CONSECUTIVE_ROLLBACKS) {
      return skip(`${functionName}:${aliasName} already rolled back ${last.count} times in a row (max ${MAX_CONSECUTIVE_ROLLBACKS}), manual action needed`);
    }
  }
  const rollbackNumber = (last?.count ?? 0) + 1;

  const previousVersion = await findPreviousVersion(lambda, functionName, currentVersion);
  if (previousVersion === undefined) {
    return skip(`${functionName}:${aliasName} is on version ${currentVersion}, no older version to roll back to`);
  }

  console.log(`Rolling back ${functionName}:${aliasName}: ${currentVersion} -> ${previousVersion} (automatic rollback #${rollbackNumber})`);
  // RevisionId makes the update fail if someone else moved the alias since we read it.
  await lambda.send(new UpdateAliasCommand({
    FunctionName: functionName,
    Name: aliasName,
    FunctionVersion: String(previousVersion),
    RevisionId: alias.RevisionId,
    Description: `auto-rollback #${rollbackNumber} from v${currentVersion} at ${new Date().toISOString()}`,
  }));

  const codeSha256 = await restoreLatest(lambda, functionName, previousVersion);

  return { rolledBack: true, functionName, aliasName, from: currentVersion, to: previousVersion, rollbackNumber, latestCodeSha256: codeSha256 };
}

// Parses the marker left in the alias description by the last rollback, if any.
// Manual rollbacks (from the workflow) start the cooldown but don't count towards the limit.
function lastRollback(description) {
  const match = ROLLBACK_MARKER.exec(description ?? '');
  if (!match) return undefined;
  const at = new Date(match[3]);
  if (Number.isNaN(at.getTime())) return undefined;
  return { count: match[1] === 'auto' ? Number(match[2] ?? 1) : 0, at };
}

// Uploads the given version's existing package as $LATEST, so unqualified calls run it too.
// Only code is restored; $LATEST keeps its current configuration. No new version is published.
async function restoreLatest(lambda, functionName, version) {
  const { Code, Configuration } = await lambda.send(new GetFunctionCommand({
    FunctionName: functionName,
    Qualifier: String(version),
  }));
  const response = await fetch(Code.Location);
  if (!response.ok) throw new Error(`Downloading version ${version} package failed: HTTP ${response.status}`);
  const zip = new Uint8Array(await response.arrayBuffer());

  console.log(`Restoring $LATEST of ${functionName} to the package of version ${version} (${Configuration.CodeSha256})`);
  const updated = await lambda.send(new UpdateFunctionCodeCommand({
    FunctionName: functionName,
    ZipFile: zip,
    Publish: false,
  }));
  await waitUntilFunctionUpdatedV2({ client: lambda, maxWaitTime: 60 }, { FunctionName: functionName });

  if (updated.CodeSha256 !== Configuration.CodeSha256) {
    throw new Error(`$LATEST code hash ${updated.CodeSha256} does not match version ${version} (${Configuration.CodeSha256})`);
  }
  console.log(`$LATEST of ${functionName} now runs the code of version ${version}`);
  return updated.CodeSha256;
}

// Runs before any rollback: checks the function is enabled in config.json and, if so,
// returns a Lambda client whose credentials can touch only that one function.
// This function's own role has no Lambda permissions; it can only assume the rollback role,
// and the session policy narrows that role down to the target function.
async function preHook(functionName) {
  if (!ENABLED_FUNCTIONS.has(functionName)) return undefined;
  console.log(`Pre-hook: ${functionName} found in config.json, rollback enabled`);

  const functionArn = `${FUNCTION_ARN_PREFIX}${functionName}`;
  const { Credentials } = await sts.send(new AssumeRoleCommand({
    RoleArn: ROLLBACK_ROLE_ARN,
    RoleSessionName: `rollback-${functionName}`.replace(/[^\w+=,.@-]/g, '-').slice(0, 64),
    DurationSeconds: 900,
    Policy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Action: [
          'lambda:GetAlias',
          'lambda:ListVersionsByFunction',
          'lambda:UpdateAlias',
          'lambda:GetFunction',
          'lambda:UpdateFunctionCode',
        ],
        Resource: [functionArn, `${functionArn}:*`],
      }],
    }),
  }));
  console.log(`Pre-hook: using credentials scoped to ${functionArn}`);

  return new LambdaClient({
    credentials: {
      accessKeyId: Credentials.AccessKeyId,
      secretAccessKey: Credentials.SecretAccessKey,
      sessionToken: Credentials.SessionToken,
      expiration: Credentials.Expiration,
    },
  });
}

// Single-metric alarms carry Trigger.Dimensions; metric-math alarms carry one
// Trigger.Metrics[].MetricStat.Metric.Dimensions per input metric.
// FunctionName=<fn>, Resource=<fn> | <fn>:<alias> | <fn>:$LATEST | <fn>:<version>.
function targetFromAlarm(alarm) {
  const trigger = alarm.Trigger ?? {};
  const dimensionSets = [
    trigger.Dimensions,
    ...(trigger.Metrics ?? []).map((m) => m.MetricStat?.Metric?.Dimensions),
  ].filter(Boolean);
  const values = (name) => dimensionSets.flatMap((dims) =>
    dims.filter((d) => (d.name ?? d.Name) === name).map((d) => d.value ?? d.Value));

  const functionName = values('FunctionName')[0];
  if (!functionName) return undefined;

  // Use an alias from the Resource dimension if there is one; $LATEST and numbered
  // versions can't be moved, so errors there roll back the default alias.
  const aliasName = values('Resource')
    .map((resource) => resource.split(':')[1])
    .find((qualifier) => qualifier && qualifier !== '$LATEST' && !/^\d+$/.test(qualifier))
    ?? DEFAULT_ALIAS;
  return { functionName, aliasName };
}

// Highest published version lower than the current one.
async function findPreviousVersion(lambda, functionName, currentVersion) {
  let previous;
  for await (const page of paginateListVersionsByFunction({ client: lambda }, { FunctionName: functionName })) {
    for (const { Version } of page.Versions ?? []) {
      if (Version === '$LATEST') continue;
      const v = Number(Version);
      if (v < currentVersion && (previous === undefined || v > previous)) previous = v;
    }
  }
  return previous;
}

function skip(reason) {
  console.log(`Skipping: ${reason}`);
  return { rolledBack: false, reason };
}
