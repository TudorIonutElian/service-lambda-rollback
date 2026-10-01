import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import rollbackConfig from '../lambda-rollback/config.json';

export const FUNCTION_NAME = 'service-lambda';
export const ALIAS_NAME = 'live';
export const ROLLBACK_FUNCTION_NAME = 'service-lambda-rollback';
export const ROLLBACK_TOPIC_NAME = 'service-lambda-rollback-notifications';

export class ServiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const fn = new lambda.Function(this, 'ServiceFunction', {
      functionName: FUNCTION_NAME,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda')),
      // Keep old versions when a new one is published, so rollback has something to point at.
      currentVersionOptions: { removalPolicy: cdk.RemovalPolicy.RETAIN },
    });

    // Every deploy with a code/config change publishes a new immutable version
    // and moves the alias to it. Rollback just moves the alias back.
    const alias = new lambda.Alias(this, 'LiveAlias', {
      aliasName: ALIAS_NAME,
      version: fn.currentVersion,
    });

    // Alarms publish here; the rollback function moves the erroring alias back one version.
    const rollbackTopic = new sns.Topic(this, 'RollbackTopic', {
      topicName: ROLLBACK_TOPIC_NAME,
    });

    const rollbackFn = new lambda.Function(this, 'RollbackFunction', {
      functionName: ROLLBACK_FUNCTION_NAME,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda-rollback')),
      timeout: cdk.Duration.seconds(30),
      environment: {
        DEFAULT_ALIAS: ALIAS_NAME,
        FUNCTION_ARN_PREFIX: `arn:${cdk.Aws.PARTITION}:lambda:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:function:`,
      },
    });

    // The rollback function's own role has no Lambda permissions. Its pre-hook checks
    // lambda-rollback/config.json, then assumes this role with a session policy scoped
    // to the single erroring function. This role is the upper bound: enabled functions only.
    const rollbackRole = new iam.Role(this, 'RollbackExecutionRole', {
      assumedBy: rollbackFn.role!,
      maxSessionDuration: cdk.Duration.hours(1),
    });
    const enabledArns = rollbackConfig.enabledFunctions.map((name) =>
      this.formatArn({ service: 'lambda', resource: 'function', resourceName: name, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME }));
    rollbackRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:GetAlias', 'lambda:ListVersionsByFunction', 'lambda:UpdateAlias'],
      resources: enabledArns.flatMap((arn) => [arn, `${arn}:*`]),
    }));
    rollbackRole.grantAssumeRole(rollbackFn.role!);
    rollbackFn.addEnvironment('ROLLBACK_ROLE_ARN', rollbackRole.roleArn);

    rollbackTopic.addSubscription(new subscriptions.LambdaSubscription(rollbackFn));

    // Errors on live and $LATEST only; calls to other numbered versions are ignored.
    // One alarm (not one per resource) so a bad minute triggers a single rollback.
    // Resource dimension: "<fn>:live" for the alias, "<fn>" for unqualified calls ($LATEST),
    // "<fn>:$LATEST" when $LATEST is named explicitly.
    const errorsFor = (resource: string) => new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'Errors',
      dimensionsMap: { FunctionName: fn.functionName, Resource: resource },
      period: cdk.Duration.minutes(1),
      statistic: cloudwatch.Stats.SUM,
    });
    const errorsAlarm = new cloudwatch.Alarm(this, 'ErrorsAlarm', {
      alarmName: `${FUNCTION_NAME}-errors`,
      alarmDescription: `Errors on ${FUNCTION_NAME}:${ALIAS_NAME} or $LATEST; rolls back ${FUNCTION_NAME}:${ALIAS_NAME}`,
      metric: new cloudwatch.MathExpression({
        expression: 'FILL(live, 0) + FILL(unqualified, 0) + FILL(latest, 0)',
        usingMetrics: {
          live: errorsFor(`${fn.functionName}:${ALIAS_NAME}`),
          unqualified: errorsFor(fn.functionName),
          latest: errorsFor(`${fn.functionName}:$LATEST`),
        },
        label: `${FUNCTION_NAME} errors (live + $LATEST)`,
        period: cdk.Duration.minutes(1),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    errorsAlarm.addAlarmAction(new cloudwatchActions.SnsAction(rollbackTopic));

    new cdk.CfnOutput(this, 'FunctionName', { value: fn.functionName });
    new cdk.CfnOutput(this, 'AliasArn', { value: alias.functionArn });
    new cdk.CfnOutput(this, 'RollbackTopicArn', { value: rollbackTopic.topicArn });
  }
}
