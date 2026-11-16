#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { AlbStack } from '../lib/alb-stack';
import { BastionStack } from '../lib/bastion-stack';
import { EcsServiceStack } from '../lib/ecs-service-stack';
import { ApiGatewayStack } from '../lib/apigateway';
import { FoundationStack } from '../lib/foundation-stack';
import { NlbStack } from '../lib/nlb-stack';
import { TransactionsLatticeStack } from '../lib/transactions-lattice-stack';
import { TransactionsStack } from '../lib/transactions-stack';
import { TransactionsDnsStack } from '../lib/transactions-dns-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const albStack = new AlbStack(app, 'AlbStack', { env });

const foundationStack = new FoundationStack(app, 'FoundationStack', { env, vpc: albStack.vpc });

const bastionStack = new BastionStack(app, 'BastionStack', {
  env,
  vpc: albStack.vpc,
  albSecurityGroup: albStack.albSecurityGroup,
});

const transactionsStack = new TransactionsStack(app, 'TransactionsStack', {
  env,
  vpc: albStack.vpc,
  clientSecurityGroups: [bastionStack.bastionSecurityGroup],
  instanceName: 'green',
});
// The image tag is read from SSM by name, so CDK can't infer this dependency.
transactionsStack.addStackDependency(foundationStack);

// Second instance of the same service; shares the ECR repo and image tag parameter.
const transactionsBlueStack = new TransactionsStack(app, 'TransactionsStackBlue', {
  env,
  vpc: albStack.vpc,
  clientSecurityGroups: [bastionStack.bastionSecurityGroup],
  instanceName: 'blue',
  repository: transactionsStack.repository,
});
transactionsBlueStack.addStackDependency(foundationStack);

new TransactionsLatticeStack(app, 'TransactionsLatticeStack', {
  env,
  vpc: albStack.vpc,
  serviceNetwork: foundationStack.serviceNetwork,
  backends: [
    { name: 'Green', alb: transactionsStack.alb, securityGroup: transactionsStack.albSecurityGroup, weight: 50 },
    { name: 'Blue', alb: transactionsBlueStack.alb, securityGroup: transactionsBlueStack.albSecurityGroup, weight: 50 },
  ],
});

const nlbStack = new NlbStack(app, 'NlbStack', {
  env,
  vpc: albStack.vpc,
  clientSecurityGroups: [bastionStack.bastionSecurityGroup],
  backends: [
    { name: 'Green', listener: transactionsStack.listener, securityGroup: transactionsStack.albSecurityGroup, weight: 50 },
    { name: 'Blue', listener: transactionsBlueStack.listener, securityGroup: transactionsBlueStack.albSecurityGroup, weight: 50 },
  ],
});

const transactionsDnsStack = new TransactionsDnsStack(app, 'TransactionsDnsStack', {
  env,
  vpc: albStack.vpc,
  backends: [
    { name: 'Green', alb: transactionsStack.alb, weight: 50 },
    { name: 'Blue', alb: transactionsBlueStack.alb, weight: 50 },
  ],
});

// Accounts calls the Transactions ALBs through weighted private DNS.
const ecsServiceStack = new EcsServiceStack(app, 'EcsServiceStack', {
  env,
  vpc: albStack.vpc,
  alb: albStack.alb,
  transactionsDnsName: transactionsDnsStack.dnsName,
  transactionsSecurityGroups: [transactionsStack.albSecurityGroup, transactionsBlueStack.albSecurityGroup],
  serviceNetwork: foundationStack.serviceNetwork,
  albSecurityGroup: albStack.albSecurityGroup,
  targetGroup: albStack.targetGroup,
  alternateTargetGroup: albStack.alternateTargetGroup,
  productionListenerRule: albStack.productionListenerRule,
});
// The image tag is read from SSM by name, so CDK can't infer this dependency.
ecsServiceStack.addStackDependency(foundationStack);
// The DNS name is a literal, so CDK cannot infer this dependency.
ecsServiceStack.addStackDependency(transactionsDnsStack);

new ApiGatewayStack(app, 'ApiGatewayStack', {
  env,
  vpc: albStack.vpc,
  albSecurityGroup: albStack.albSecurityGroup,
  listener: albStack.listener,
});
