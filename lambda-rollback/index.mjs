// Invoked by SNS when a CloudWatch alarm on a Lambda alias goes into ALARM.
// Moves the alias back to the previous published version. No build, no upload.
import {
  LambdaClient,
  GetAliasCommand,
  UpdateAliasCommand,
  paginateListVersionsByFunction,
} from '@aws-sdk/client-lambda';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import config from './config.json' with { type: 'json' };

const sts = new STSClient({});
const DEFAULT_ALIAS = process.env.DEFAULT_ALIAS ?? 'live';
const ROLLBACK_ROLE_ARN = process.env.ROLLBACK_ROLE_ARN;
// e.g. arn:aws:lambda:eu-central-1:123456789012:function:
const FUNCTION_ARN_PREFIX = process.env.FUNCTION_ARN_PREFIX;
// Only functions listed here are plugged into automatic rollback.
const ENABLED_FUNCTIONS = new Set(config.enabledFunctions ?? []);

export const handler = async (event) => {
  const results = [];
  for (const record of event.Records ?? []) {
    const alarm = JSON.parse(record.Sns.Message);
    results.push(await handleAlarm(alarm));
  }
  return results;
};

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

  const previousVersion = await findPreviousVersion(lambda, functionName, currentVersion);
  if (previousVersion === undefined) {
    return skip(`${functionName}:${aliasName} is on version ${currentVersion}, no older version to roll back to`);
  }

  console.log(`Rolling back ${functionName}:${aliasName}: ${currentVersion} -> ${previousVersion}`);
  // RevisionId makes the update fail if someone else moved the alias since we read it.
  await lambda.send(new UpdateAliasCommand({
    FunctionName: functionName,
    Name: aliasName,
    FunctionVersion: String(previousVersion),
    RevisionId: alias.RevisionId,
  }));

  return { rolledBack: true, functionName, aliasName, from: currentVersion, to: previousVersion };
}

// Runs before any rollback: checks the function is enabled in config.json and, if so,
// returns a Lambda client whose credentials can touch only that one function.
// This function's own role has no Lambda permissions; it can only assume the rollback role,
// and the session policy narrows that role down to the target function.
async function preHook(functionName) {
  if (!ENABLED_FUNCTIONS.has(functionName)) return undefined;

  const functionArn = `${FUNCTION_ARN_PREFIX}${functionName}`;
  const { Credentials } = await sts.send(new AssumeRoleCommand({
    RoleArn: ROLLBACK_ROLE_ARN,
    RoleSessionName: `rollback-${functionName}`.replace(/[^\w+=,.@-]/g, '-').slice(0, 64),
    DurationSeconds: 900,
    Policy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Action: ['lambda:GetAlias', 'lambda:ListVersionsByFunction', 'lambda:UpdateAlias'],
        Resource: [functionArn, `${functionArn}:*`],
      }],
    }),
  }));
  console.log(`Pre-hook: ${functionName} enabled, using credentials scoped to ${functionArn}`);

  return new LambdaClient({
    credentials: {
      accessKeyId: Credentials.AccessKeyId,
      secretAccessKey: Credentials.SecretAccessKey,
      sessionToken: Credentials.SessionToken,
      expiration: Credentials.Expiration,
    },
  });
}

// Alarms on an alias carry dimensions FunctionName=<fn> and Resource=<fn>:<alias>.
function targetFromAlarm(alarm) {
  const dimensions = alarm.Trigger?.Dimensions ?? [];
  const value = (name) => dimensions.find((d) => d.name === name)?.value;

  const functionName = value('FunctionName');
  if (!functionName) return undefined;

  const resource = value('Resource');
  const aliasName = resource?.includes(':') ? resource.split(':').pop() : DEFAULT_ALIAS;
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
