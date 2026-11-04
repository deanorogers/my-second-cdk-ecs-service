#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { AlbStack } from '../lib/alb-stack';
import { BastionStack } from '../lib/bastion-stack';
import { EcsServiceStack } from '../lib/ecs-service-stack';
import { ApiGatewayStack } from '../lib/apigateway';
import { FoundationStack } from '../lib/foundation-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const foundationStack = new FoundationStack(app, 'FoundationStack', { env });

const albStack = new AlbStack(app, 'AlbStack', { env });

const ecsServiceStack = new EcsServiceStack(app, 'EcsServiceStack', {
  env,
  vpc: albStack.vpc,
  albSecurityGroup: albStack.albSecurityGroup,
  targetGroup: albStack.targetGroup,
  alternateTargetGroup: albStack.alternateTargetGroup,
  productionListenerRule: albStack.productionListenerRule,
});
// The image tag is read from SSM by name, so CDK can't infer this dependency.
ecsServiceStack.addStackDependency(foundationStack);

new BastionStack(app, 'BastionStack', {
  env,
  vpc: albStack.vpc,
  albSecurityGroup: albStack.albSecurityGroup,
});

new ApiGatewayStack(app, 'ApiGatewayStack', {
  env,
  vpc: albStack.vpc,
  albSecurityGroup: albStack.albSecurityGroup,
  listener: albStack.listener,
});
