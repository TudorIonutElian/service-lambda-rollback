// Rollback system for registered Lambda functions (see config.json).
//
// Invoked by:
//   - SNS, when a registered CloudWatch alarm goes into ALARM;
//   - EventBridge every few minutes ({ type: 'scheduled-check' }): syncs metadata, marks the live
//     version stable when all its alarms are OK, and re-checks alarms still in ALARM (CloudWatch
//     only notifies on state changes);
//   - the deploy workflows after `cdk deploy` ({ type: 'sync' }).
//
// Sync keeps a DynamoDB record of every published version and copies each version's package to S3
// as <fn>/<fn>-<version>.zip. A rollback moves the alias to the previous archived version and
// restores $LATEST from that zip. Nothing is rebuilt.
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
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  QueryCommand,
  paginateQuery,
} from '@aws-sdk/client-dynamodb';
import config from './config.json' with { type: 'json' };

const sts = new STSClient({});
const cloudwatch = new CloudWatchClient({});
const DEFAULT_ALIAS = process.env.DEFAULT_ALIAS ?? 'live';
const ROLLBACK_ROLE_ARN = process.env.ROLLBACK_ROLE_ARN;
// e.g. arn:aws:lambda:eu-central-1:123456789012:function:
const FUNCTION_ARN_PREFIX = process.env.FUNCTION_ARN_PREFIX;
const TABLE_NAME = process.env.TABLE_NAME;
const TABLE_ARN = process.env.TABLE_ARN;
const BUCKET_NAME = process.env.BUCKET_NAME;

// Automatic rollbacks in a row before giving up; the count resets on the next deploy.
// Default for functions that don't set their own maxConsecutiveRollbacks.
const DEFAULT_MAX_CONSECUTIVE_ROLLBACKS = config.maxConsecutiveRollbacks ?? 2;
// Functions registered for automatic rollback, their alias, rollback limit, and the alarms allowed
// to trigger them. Deregister a function by removing it or setting "enabled": false.
const REGISTERED = new Map((config.functions ?? [])
  .filter((fn) => fn.enabled !== false)
  .map((fn) => [fn.name, {
    alias: fn.alias ?? DEFAULT_ALIAS,
    alarms: new Set(fn.alarms ?? []),
    maxConsecutiveRollbacks: fn.maxConsecutiveRollbacks ?? DEFAULT_MAX_CONSECUTIVE_ROLLBACKS,
  }]));
// Time the alarm gets to evaluate a version after a rollback, before another one may happen.
const COOLDOWN_MS = Number(process.env.ROLLBACK_COOLDOWN_MINUTES ?? 3) * 60_000;
// How long a version must have been live, with all its alarms OK, before it is marked stable.
const STABLE_AFTER_MS = Number(process.env.STABLE_AFTER_MINUTES ?? 5) * 60_000;

const CURRENT_SK = 'CURRENT';
const versionSk = (version) => `VERSION#${String(version).padStart(10, '0')}`;
const s3Key = (functionName, version) => `${functionName}/${functionName}-${version}.zip`;

export const handler = async (event) => {
  if (event.type === 'scheduled-check') {
    await syncAll();
    const alarms = await describeRegisteredAlarms();
    const stable = await markStable(alarms);
    const rollbacks = await checkAlarms(alarms);
    return [...stable, ...rollbacks];
  }
  if (event.type === 'sync') {
    return syncAll(event.functionName);
  }

  const results = [];
  for (const record of event.Records ?? []) {
    const alarm = JSON.parse(record.Sns.Message);
    results.push(await handleAlarm(alarm));
  }
  return results;
};

// ---------------------------------------------------------------------------------------------
// Sync: archive new versions to S3 + DynamoDB, and record alias moves made outside the system.
// ---------------------------------------------------------------------------------------------

async function syncAll(onlyFunction) {
  const names = [...REGISTERED.keys()].filter((name) => !onlyFunction || name === onlyFunction);
  if (onlyFunction && names.length === 0) {
    return [skip(`${onlyFunction} is not registered for rollback (see config.json)`)];
  }
  const results = [];
  for (const functionName of names) {
    try {
      const clients = await scopedClients(functionName);
      results.push(await syncFunction(clients, functionName));
    } catch (err) {
      console.error(`Sync of ${functionName} failed: ${err.name}: ${err.message}`);
      results.push({ functionName, synced: false, error: err.message });
    }
  }
  return results;
}

async function syncFunction(clients, functionName) {
  const { lambda, ddb } = clients;
  const known = new Set((await queryVersions(ddb, functionName)).map((item) => item.version));

  const archived = [];
  for await (const page of paginateListVersionsByFunction({ client: lambda }, { FunctionName: functionName })) {
    for (const { Version } of page.Versions ?? []) {
      if (Version === '$LATEST' || known.has(Number(Version))) continue;
      await archiveVersion(clients, functionName, Number(Version));
      archived.push(Number(Version));
    }
  }

  const currentVersion = await syncCurrent(clients, functionName);
  return { functionName, synced: true, archived, currentVersion };
}

// Copies a published version's package to S3 and records its metadata.
async function archiveVersion({ lambda, s3, ddb }, functionName, version) {
  const { Code, Configuration } = await lambda.send(new GetFunctionCommand({
    FunctionName: functionName,
    Qualifier: String(version),
  }));
  if (Configuration.PackageType === 'Image') {
    throw new Error(`${functionName} v${version} is a container image; only zip packages can be archived`);
  }
  const response = await fetch(Code.Location);
  if (!response.ok) throw new Error(`Downloading ${functionName} v${version} failed: HTTP ${response.status}`);
  const zip = new Uint8Array(await response.arrayBuffer());

  const key = s3Key(functionName, version);
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: zip,
    ContentType: 'application/zip',
    Metadata: { 'code-sha256': Configuration.CodeSha256, 'function-version': String(version) },
  }));

  await ddb.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      functionName: S(functionName),
      sk: S(versionSk(version)),
      version: N(version),
      codeSha256: S(Configuration.CodeSha256),
      description: S(Configuration.Description ?? ''),
      lastModified: S(Configuration.LastModified),
      runtime: S(Configuration.Runtime ?? ''),
      handler: S(Configuration.Handler ?? ''),
      memorySize: N(Configuration.MemorySize),
      timeout: N(Configuration.Timeout),
      codeSize: N(Configuration.CodeSize),
      s3Bucket: S(BUCKET_NAME),
      s3Key: S(key),
      archivedAt: S(new Date().toISOString()),
    },
  }));
  console.log(`Archived ${functionName} v${version} (${Configuration.CodeSha256}) to s3://${BUCKET_NAME}/${key}`);
}

// If the alias points somewhere the table doesn't know about, it was moved outside the rollback
// system (a deploy, or by hand): record it as the current version and reset the rollback count.
async function syncCurrent({ lambda, ddb }, functionName) {
  const { alias } = REGISTERED.get(functionName);
  const aliasVersion = Number((await lambda.send(new GetAliasCommand({
    FunctionName: functionName,
    Name: alias,
  }))).FunctionVersion);

  const current = await getCurrent(ddb, functionName);
  if (current?.version === aliasVersion) return aliasVersion;

  try {
    await ddb.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        functionName: S(functionName),
        sk: S(CURRENT_SK),
        version: N(aliasVersion),
        ...(current ? { previousVersion: N(current.version) } : {}),
        updatedBy: S('deploy'),
        updatedAt: S(new Date().toISOString()),
        rollbackCount: N(0),
      },
      // Don't overwrite a concurrent rollback's record.
      ConditionExpression: current ? 'version = :seen' : 'attribute_not_exists(sk)',
      ExpressionAttributeValues: current ? { ':seen': N(current.version) } : undefined,
    }));
    console.log(`${functionName}:${alias} moved to v${aliasVersion} outside the rollback system; recorded as deploy`);
  } catch (err) {
    if (err.name !== 'ConditionalCheckFailedException') throw err;
  }
  return aliasVersion;
}

// ---------------------------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------------------------

async function describeRegisteredAlarms() {
  const alarmNames = [...REGISTERED.values()].flatMap(({ alarms }) => [...alarms]);
  if (alarmNames.length === 0) return [];
  const { MetricAlarms = [] } = await cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: alarmNames }));
  return MetricAlarms;
}

// Scheduled check: a function whose registered alarms are all OK, and whose live version has been
// live for at least STABLE_AFTER_MINUTES, gets that version marked stable, both on CURRENT and on
// the version's own item. Done once per version (until it is rolled back from).
async function markStable(alarms) {
  const states = new Map(alarms.map((alarm) => [alarm.AlarmName, alarm.StateValue]));
  const results = [];
  for (const [functionName, { alarms: registered }] of REGISTERED) {
    if (registered.size === 0) continue;
    const notOk = [...registered].filter((name) => states.get(name) !== 'OK');
    if (notOk.length > 0) {
      console.log(`${functionName}: not stable, alarms not OK: ${notOk.map((name) => `${name}=${states.get(name) ?? 'missing'}`).join(', ')}`);
      continue;
    }
    try {
      const { ddb } = await scopedClients(functionName);
      const current = await getCurrent(ddb, functionName);
      if (!current || current.stable) continue;
      const liveForMs = Date.now() - new Date(current.updatedAt).getTime();
      if (!(liveForMs >= STABLE_AFTER_MS)) {
        console.log(`${functionName}: v${current.version} live for ${Math.round(liveForMs / 1000)}s, not marked stable yet`);
        continue;
      }
      results.push(await recordStable(ddb, functionName, current.version));
    } catch (err) {
      console.error(`Marking ${functionName} stable failed: ${err.name}: ${err.message}`);
      results.push({ functionName, stable: false, error: err.message });
    }
  }
  return results;
}

async function recordStable(ddb, functionName, version) {
  const now = new Date().toISOString();
  try {
    // Only if CURRENT still points at this version (a rollback may have just moved it).
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: { functionName: S(functionName), sk: S(CURRENT_SK) },
      UpdateExpression: 'SET stable = :true, stableAt = :now',
      ConditionExpression: 'version = :version',
      ExpressionAttributeValues: { ':true': { BOOL: true }, ':now': S(now), ':version': N(version) },
    }));
  } catch (err) {
    if (err.name !== 'ConditionalCheckFailedException') throw err;
    return { functionName, version, stable: false, reason: 'live version changed' };
  }
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: { functionName: S(functionName), sk: S(versionSk(version)) },
      UpdateExpression: 'SET stable = :true, stableAt = :now',
      ConditionExpression: 'attribute_exists(sk)',
      ExpressionAttributeValues: { ':true': { BOOL: true }, ':now': S(now) },
    }));
  } catch (err) {
    if (err.name !== 'ConditionalCheckFailedException') throw err;
  }
  console.log(`${functionName}: all alarms OK, v${version} marked stable`);
  return { functionName, version, stable: true };
}

// Scheduled re-check: treat every registered alarm still in ALARM as if it had just fired.
async function checkAlarms(alarms) {
  const results = [];
  for (const alarm of alarms) {
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

  const functionName = functionFromAlarm(alarm);
  if (!functionName) {
    return skip('alarm has no FunctionName dimension');
  }

  const { clients, reason } = await preHook(functionName, alarm.AlarmName);
  if (!clients) {
    return skip(reason);
  }
  const { lambda, ddb } = clients;
  const { alias: aliasName, maxConsecutiveRollbacks } = REGISTERED.get(functionName);

  // Make sure the newest version is archived and any deploy since the last run is recorded.
  await syncFunction(clients, functionName);

  const alias = await lambda.send(new GetAliasCommand({ FunctionName: functionName, Name: aliasName }));
  const currentVersion = Number(alias.FunctionVersion);

  const state = await getCurrent(ddb, functionName);
  if (state?.lastRollbackAt) {
    const sinceMs = Date.now() - new Date(state.lastRollbackAt).getTime();
    if (sinceMs < COOLDOWN_MS) {
      return skip(`${functionName}:${aliasName} was rolled back ${Math.round(sinceMs / 1000)}s ago, giving the alarm time to evaluate version ${currentVersion}`);
    }
  }
  if ((state?.rollbackCount ?? 0) >= maxConsecutiveRollbacks) {
    return skip(`${functionName}:${aliasName} already rolled back ${state?.rollbackCount ?? 0} times in a row (max ${maxConsecutiveRollbacks}), manual action needed`);
  }
  const rollbackNumber = (state?.rollbackCount ?? 0) + 1;

  const target = await findPreviousArchived(ddb, functionName, currentVersion);
  if (!target) {
    return skip(`${functionName}:${aliasName} is on version ${currentVersion}, no older archived version to roll back to`);
  }

  console.log(`Rolling back ${functionName}:${aliasName}: ${currentVersion} -> ${target.version} (automatic rollback #${rollbackNumber})`);
  // RevisionId makes the update fail if someone else moved the alias since we read it.
  await lambda.send(new UpdateAliasCommand({
    FunctionName: functionName,
    Name: aliasName,
    FunctionVersion: String(target.version),
    RevisionId: alias.RevisionId,
  }));

  await restoreLatest(clients, functionName, target);
  await recordRollback(ddb, functionName, {
    from: currentVersion,
    to: target.version,
    by: 'auto-rollback',
    rollbackCount: rollbackNumber,
    reason: `alarm ${alarm.AlarmName}`,
  });

  return {
    rolledBack: true,
    functionName,
    aliasName,
    from: currentVersion,
    to: target.version,
    rollbackNumber,
    restoredFrom: `s3://${target.s3Bucket}/${target.s3Key}`,
  };
}

// Single-metric alarms carry Trigger.Dimensions; metric-math alarms carry one
// Trigger.Metrics[].MetricStat.Metric.Dimensions per input metric.
function functionFromAlarm(alarm) {
  const trigger = alarm.Trigger ?? {};
  const dimensionSets = [
    trigger.Dimensions,
    ...(trigger.Metrics ?? []).map((m) => m.MetricStat?.Metric?.Dimensions),
  ].filter(Boolean);
  return dimensionSets
    .flatMap((dims) => dims.filter((d) => (d.name ?? d.Name) === 'FunctionName'))
    .map((d) => d.value ?? d.Value)[0];
}

// ---------------------------------------------------------------------------------------------
// Rollback steps
// ---------------------------------------------------------------------------------------------

// Lambda pulls the archived zip from S3 itself; it becomes $LATEST's code, no version is published.
// Only code is restored; $LATEST keeps its current configuration.
async function restoreLatest({ lambda }, functionName, target) {
  console.log(`Restoring $LATEST of ${functionName} from s3://${target.s3Bucket}/${target.s3Key}`);
  const updated = await lambda.send(new UpdateFunctionCodeCommand({
    FunctionName: functionName,
    S3Bucket: target.s3Bucket,
    S3Key: target.s3Key,
    Publish: false,
  }));
  await waitUntilFunctionUpdatedV2({ client: lambda, maxWaitTime: 60 }, { FunctionName: functionName });

  if (updated.CodeSha256 !== target.codeSha256) {
    throw new Error(`$LATEST code hash ${updated.CodeSha256} does not match version ${target.version} (${target.codeSha256})`);
  }
  console.log(`$LATEST of ${functionName} now runs the code of version ${target.version}`);
}

async function recordRollback(ddb, functionName, { from, to, by, rollbackCount, reason }) {
  const now = new Date().toISOString();
  await ddb.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      functionName: S(functionName),
      sk: S(CURRENT_SK),
      version: N(to),
      previousVersion: N(from),
      updatedBy: S(by),
      updatedAt: S(now),
      lastRollbackAt: S(now),
      rollbackCount: N(rollbackCount),
    },
  }));
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: { functionName: S(functionName), sk: S(versionSk(from)) },
      UpdateExpression: 'SET rolledBackAt = :at, rolledBackBy = :by, rollbackReason = :reason, stable = :false',
      ConditionExpression: 'attribute_exists(sk)',
      ExpressionAttributeValues: { ':at': S(now), ':by': S(by), ':reason': S(reason), ':false': { BOOL: false } },
    }));
  } catch (err) {
    if (err.name !== 'ConditionalCheckFailedException') throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Pre-hook and scoped credentials
// ---------------------------------------------------------------------------------------------

// Runs before any rollback: checks the function is registered in config.json and the alarm
// is one of its registered alarms. If so, returns clients whose credentials can touch only that
// one function (and its S3 folder and DynamoDB items); otherwise returns the reason to skip.
async function preHook(functionName, alarmName) {
  const registration = REGISTERED.get(functionName);
  if (!registration) {
    return { reason: `${functionName} is not registered for rollback (see config.json)` };
  }
  if (!registration.alarms.has(alarmName)) {
    return { reason: `alarm '${alarmName}' is not registered for ${functionName} (see config.json)` };
  }
  console.log(`Pre-hook: ${functionName} found in config.json with alarm '${alarmName}', rollback enabled`);
  return { clients: await scopedClients(functionName) };
}

// This function's own role has no Lambda, S3 or DynamoDB permissions; it can only assume the
// rollback role, and the session policy narrows that role down to one function.
async function scopedClients(functionName) {
  const functionArn = `${FUNCTION_ARN_PREFIX}${functionName}`;
  const { Credentials } = await sts.send(new AssumeRoleCommand({
    RoleArn: ROLLBACK_ROLE_ARN,
    RoleSessionName: `rollback-${functionName}`.replace(/[^\w+=,.@-]/g, '-').slice(0, 64),
    DurationSeconds: 900,
    Policy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: [
            'lambda:GetAlias',
            'lambda:ListVersionsByFunction',
            'lambda:UpdateAlias',
            'lambda:GetFunction',
            'lambda:UpdateFunctionCode',
          ],
          Resource: [functionArn, `${functionArn}:*`],
        },
        {
          Effect: 'Allow',
          Action: ['s3:GetObject', 's3:PutObject'],
          Resource: `arn:aws:s3:::${BUCKET_NAME}/${functionName}/*`,
        },
        {
          Effect: 'Allow',
          Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
          Resource: TABLE_ARN,
          Condition: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [functionName] } },
        },
      ],
    }),
  }));
  console.log(`Using credentials scoped to ${functionArn}`);

  const credentials = {
    accessKeyId: Credentials.AccessKeyId,
    secretAccessKey: Credentials.SecretAccessKey,
    sessionToken: Credentials.SessionToken,
    expiration: Credentials.Expiration,
  };
  return {
    lambda: new LambdaClient({ credentials }),
    s3: new S3Client({ credentials }),
    ddb: new DynamoDBClient({ credentials }),
  };
}

// ---------------------------------------------------------------------------------------------
// DynamoDB helpers
// ---------------------------------------------------------------------------------------------

async function getCurrent(ddb, functionName) {
  const { Item } = await ddb.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: { functionName: S(functionName), sk: S(CURRENT_SK) },
    ConsistentRead: true,
  }));
  if (!Item) return undefined;
  return {
    version: Number(Item.version.N),
    rollbackCount: Number(Item.rollbackCount?.N ?? 0),
    lastRollbackAt: Item.lastRollbackAt?.S,
    updatedBy: Item.updatedBy?.S,
    updatedAt: Item.updatedAt?.S,
    stable: Item.stable?.BOOL === true,
  };
}

async function queryVersions(ddb, functionName) {
  const items = [];
  const pages = paginateQuery({ client: ddb }, {
    TableName: TABLE_NAME,
    KeyConditionExpression: 'functionName = :f AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':f': S(functionName), ':prefix': S('VERSION#') },
    ProjectionExpression: 'version',
    ConsistentRead: true,
  });
  for await (const page of pages) {
    for (const item of page.Items ?? []) items.push({ version: Number(item.version.N) });
  }
  return items;
}

// Highest archived version lower than the current one.
async function findPreviousArchived(ddb, functionName, currentVersion) {
  if (currentVersion <= 1) return undefined;
  const { Items = [] } = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'functionName = :f AND sk BETWEEN :low AND :high',
    ExpressionAttributeValues: {
      ':f': S(functionName),
      ':low': S(versionSk(0)),
      ':high': S(versionSk(currentVersion - 1)),
    },
    ScanIndexForward: false,
    Limit: 1,
    ConsistentRead: true,
  }));
  const item = Items[0];
  if (!item) return undefined;
  return {
    version: Number(item.version.N),
    codeSha256: item.codeSha256.S,
    s3Bucket: item.s3Bucket.S,
    s3Key: item.s3Key.S,
  };
}

function S(value) {
  return { S: String(value ?? '') };
}

function N(value) {
  return { N: String(value) };
}

function skip(reason) {
  console.log(`Skipping: ${reason}`);
  return { rolledBack: false, reason };
}
