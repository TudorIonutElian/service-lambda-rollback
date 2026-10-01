import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export const FUNCTION_NAME = 'service-lambda';
export const ALIAS_NAME = 'live';

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

    new cdk.CfnOutput(this, 'FunctionName', { value: fn.functionName });
    new cdk.CfnOutput(this, 'AliasArn', { value: alias.functionArn });
  }
}
