import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

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
      environment: { DEFAULT_ALIAS: ALIAS_NAME },
    });

    // Only allowed to move aliases of the service function.
    rollbackFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:GetAlias', 'lambda:ListVersionsByFunction', 'lambda:UpdateAlias'],
      resources: [fn.functionArn, `${fn.functionArn}:*`],
    }));

    rollbackTopic.addSubscription(new subscriptions.LambdaSubscription(rollbackFn));

    // Errors on the alias (not the bare function), so the alarm carries
    // FunctionName and Resource=<fn>:<alias> dimensions the rollback function reads.
    const errorsAlarm = new cloudwatch.Alarm(this, 'LiveErrorsAlarm', {
      alarmName: `${FUNCTION_NAME}-${ALIAS_NAME}-errors`,
      alarmDescription: `Errors on ${FUNCTION_NAME}:${ALIAS_NAME}; triggers automatic rollback`,
      metric: alias.metricErrors({ period: cdk.Duration.minutes(1), statistic: cloudwatch.Stats.SUM }),
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
