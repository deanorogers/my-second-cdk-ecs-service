import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AlbStack } from '../lib/alb-stack';
import { EcsServiceStack } from '../lib/ecs-service-stack';
import { FoundationStack, IMAGE_TAG_PARAM_NAME, TRANSACTIONS_IMAGE_TAG_PARAM_NAME } from '../lib/foundation-stack';
import { BastionStack } from '../lib/bastion-stack';
import { TransactionsStack } from '../lib/transactions-stack';
import { TransactionsLatticeStack } from '../lib/transactions-lattice-stack';
import { NlbStack } from '../lib/nlb-stack';

test('ALB SG only allows HTTP from allowed CIDR', () => {
  const app = new cdk.App();
  const alb = new AlbStack(app, 'Alb', undefined);
  const foundation = new FoundationStack(app, 'Foundation', { vpc: alb.vpc });
  const tx = new TransactionsStack(app, 'TxForSvc', { vpc: alb.vpc });
  const svc = new EcsServiceStack(app, 'Svc', {
    vpc: alb.vpc,
    alb: alb.alb,
    transactionsDnsName: tx.alb.loadBalancerDnsName,
    transactionsSecurityGroup: tx.albSecurityGroup,
    albSecurityGroup: alb.albSecurityGroup,
    serviceNetwork: foundation.serviceNetwork,
    targetGroup: alb.targetGroup,
    alternateTargetGroup: alb.alternateTargetGroup,
    productionListenerRule: alb.productionListenerRule,
  });
  Template.fromStack(alb).hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Scheme: 'internal',
  });
  Template.fromStack(alb).hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: Match.stringLikeRegexp('Internal ALB'),
    SecurityGroupIngress: Match.absent(),
  });
  Template.fromStack(svc).resourceCountIs('AWS::ECS::Service', 1);
  Template.fromStack(svc).hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    Description: 'HTTP from accounts service',
    FromPort: 80,
    ToPort: 80,
    SourceSecurityGroupId: Match.anyValue(),
  });
  Template.fromStack(svc).hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    IpProtocol: 'tcp',
    FromPort: 80,
    ToPort: 80,
    SourcePrefixListId: Match.anyValue(),
  });
  Template.fromStack(svc).hasResourceProperties('AWS::VpcLattice::TargetGroup', {
    Type: 'ALB',
    Config: Match.objectLike({ Port: 80, Protocol: 'HTTP', HealthCheck: Match.absent() }),
  });
  Template.fromStack(svc).hasResourceProperties('AWS::VpcLattice::Listener', {
    Protocol: 'HTTP',
    Port: 80,
  });
  Template.fromStack(svc).resourceCountIs('AWS::VpcLattice::Service', 1);
  Template.fromStack(svc).resourceCountIs('AWS::VpcLattice::ServiceNetworkServiceAssociation', 1);
  Template.fromStack(svc).resourceCountIs('AWS::CloudWatch::Alarm', 2);
  Template.fromStack(svc).hasResourceProperties('AWS::ECS::Service', {
    DeploymentConfiguration: Match.objectLike({
      DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      Alarms: {
        AlarmNames: [
          { Ref: Match.stringLikeRegexp('^PrimaryTarget5xxAlarm') },
          { Ref: Match.stringLikeRegexp('^AlternateTarget5xxAlarm') },
        ],
        Enable: true,
        Rollback: true,
      },
    }),
  });
  Template.fromStack(svc).hasParameter('MyImageTag', {
    Type: 'AWS::SSM::Parameter::Value<String>',
    Default: IMAGE_TAG_PARAM_NAME,
  });
  Template.fromStack(svc).hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: 'web',
        Image: {
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([{ Ref: 'MyImageTag' }]),
          ]),
        },
      }),
    ]),
  });
});

test('Foundation stack owns the image tag SSM parameter and the Lattice service network', () => {
  const app = new cdk.App();
  const alb = new AlbStack(app, 'Alb', undefined);
  const foundation = new FoundationStack(app, 'Foundation', { vpc: alb.vpc });
  const template = Template.fromStack(foundation);
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: IMAGE_TAG_PARAM_NAME,
    Type: 'String',
  });
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: TRANSACTIONS_IMAGE_TAG_PARAM_NAME,
    Type: 'String',
  });
  template.resourceCountIs('AWS::VpcLattice::ServiceNetwork', 1);
  template.hasResourceProperties('AWS::VpcLattice::ServiceNetwork', {
    Name: 'my-second-cdk-ecs-service-network',
    AuthType: 'NONE',
  });
  template.resourceCountIs('AWS::VpcLattice::ServiceNetworkVpcAssociation', 1);
  template.hasResourceProperties('AWS::VpcLattice::ServiceNetworkVpcAssociation', {
    ServiceNetworkIdentifier: Match.anyValue(),
    VpcIdentifier: Match.anyValue(),
  });
});

test('Transactions stack has its own internal ALB and canary ECS service', () => {
  const app = new cdk.App();
  const alb = new AlbStack(app, 'Alb', undefined);
  const bastion = new BastionStack(app, 'Bastion', { vpc: alb.vpc, albSecurityGroup: alb.albSecurityGroup });
  const tx = new TransactionsStack(app, 'Tx', {
    vpc: alb.vpc,
    clientSecurityGroups: [bastion.bastionSecurityGroup],
  });
  const template = Template.fromStack(tx);

  template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { Scheme: 'internal' });
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 2);
  template.resourceCountIs('AWS::ECR::Repository', 1);
  template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
  template.hasParameter('MyImageTag', {
    Type: 'AWS::SSM::Parameter::Value<String>',
    Default: TRANSACTIONS_IMAGE_TAG_PARAM_NAME,
  });
  template.hasResourceProperties('AWS::ECS::Service', {
    DeploymentConfiguration: Match.objectLike({
      Strategy: 'CANARY',
      DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      Alarms: Match.objectLike({ Enable: true, Rollback: true }),
    }),
  });
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: 'transactions',
        Image: { 'Fn::Join': Match.arrayWith([Match.arrayWith([{ Ref: 'MyImageTag' }])]) },
      }),
    ]),
  });
  // The ALB SG has no inline ingress; the bastion is allowed via a separate rule.
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: Match.stringLikeRegexp('transactions ALB'),
    SecurityGroupIngress: Match.absent(),
  });
  template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 2);
});

test('NLB stack weight-balances across two Transactions ALBs', () => {
  const app = new cdk.App();
  const alb = new AlbStack(app, 'Alb', undefined);
  const green = new TransactionsStack(app, 'TxGreen', { vpc: alb.vpc, instanceName: 'green' });
  const blue = new TransactionsStack(app, 'TxBlue', {
    vpc: alb.vpc,
    instanceName: 'blue',
    repository: green.repository,
  });
  const nlb = new NlbStack(app, 'Nlb', {
    vpc: alb.vpc,
    backends: [
      { name: 'Green', listener: green.listener, securityGroup: green.albSecurityGroup, weight: 70 },
      { name: 'Blue', listener: blue.listener, securityGroup: blue.albSecurityGroup, weight: 30 },
    ],
  });

  Template.fromStack(blue).resourceCountIs('AWS::ECR::Repository', 0);
  Template.fromStack(blue).hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({ Environment: [{ Name: 'INSTANCE_NAME', Value: 'blue' }] }),
    ]),
  });

  const template = Template.fromStack(nlb);
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Type: 'network',
    Scheme: 'internal',
  });
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 2);
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', { TargetType: 'alb' });
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
    DefaultActions: [
      Match.objectLike({
        ForwardConfig: {
          TargetGroups: [
            Match.objectLike({ Weight: 70 }),
            Match.objectLike({ Weight: 30 }),
          ],
        },
      }),
    ],
  });
  template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 2);
});

test('Transactions Lattice stack weights two ALB-type target groups on the service network', () => {
  const app = new cdk.App();
  const alb = new AlbStack(app, 'Alb', undefined);
  const foundation = new FoundationStack(app, 'Foundation', { vpc: alb.vpc });
  const green = new TransactionsStack(app, 'TxGreen', { vpc: alb.vpc });
  const blue = new TransactionsStack(app, 'TxBlue', { vpc: alb.vpc, repository: green.repository });
  const lattice = new TransactionsLatticeStack(app, 'TxLattice', {
    vpc: alb.vpc,
    serviceNetwork: foundation.serviceNetwork,
    backends: [
      { name: 'Green', alb: green.alb, securityGroup: green.albSecurityGroup, weight: 70 },
      { name: 'Blue', alb: blue.alb, securityGroup: blue.albSecurityGroup, weight: 30 },
    ],
  });

  const template = Template.fromStack(lattice);
  template.resourceCountIs('AWS::VpcLattice::TargetGroup', 2);
  template.hasResourceProperties('AWS::VpcLattice::TargetGroup', { Type: 'ALB' });
  template.resourceCountIs('AWS::VpcLattice::Service', 1);
  template.resourceCountIs('AWS::VpcLattice::ServiceNetworkServiceAssociation', 1);
  template.hasResourceProperties('AWS::VpcLattice::Listener', {
    DefaultAction: {
      Forward: {
        TargetGroups: [
          Match.objectLike({ Weight: 70 }),
          Match.objectLike({ Weight: 30 }),
        ],
      },
    },
  });
  template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 2);
});
