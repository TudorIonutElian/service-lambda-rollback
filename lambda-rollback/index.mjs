// Invoked by SNS when a CloudWatch alarm on a Lambda alias goes into ALARM.
// Moves the alias back to the previous published version. No build, no upload.
import {
  LambdaClient,
  GetAliasCommand,
  UpdateAliasCommand,
  paginateListVersionsByFunction,
} from '@aws-sdk/client-lambda';

const lambda = new LambdaClient({});
const DEFAULT_ALIAS = process.env.DEFAULT_ALIAS ?? 'live';

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

  const alias = await lambda.send(new GetAliasCommand({ FunctionName: functionName, Name: aliasName }));
  const currentVersion = Number(alias.FunctionVersion);

  const previousVersion = await findPreviousVersion(functionName, currentVersion);
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
async function findPreviousVersion(functionName, currentVersion) {
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
