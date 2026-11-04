#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { AlbStack } from '../lib/alb-stack';
import { BastionStack } from '../lib/bastion-stack';
import { EcsServiceStack } from '../lib/ecs-service-stack';
import { ApiGatewayStack } from '../lib/apigateway';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const albStack = new AlbStack(app, 'AlbStack', { env });

new EcsServiceStack(app, 'EcsServiceStack', {
  env,
  vpc: albStack.vpc,
  albSecurityGroup: albStack.albSecurityGroup,
  targetGroup: albStack.targetGroup,
  alternateTargetGroup: albStack.alternateTargetGroup,
  productionListenerRule: albStack.productionListenerRule,
});

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
