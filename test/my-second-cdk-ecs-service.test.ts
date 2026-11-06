import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AlbStack } from '../lib/alb-stack';
import { EcsServiceStack } from '../lib/ecs-service-stack';
import { FoundationStack, IMAGE_TAG_PARAM_NAME } from '../lib/foundation-stack';

test('ALB SG only allows HTTP from allowed CIDR', () => {
  const app = new cdk.App();
  const alb = new AlbStack(app, 'Alb', undefined);
  const foundation = new FoundationStack(app, 'Foundation', { vpc: alb.vpc });
  const svc = new EcsServiceStack(app, 'Svc', {
    vpc: alb.vpc,
    alb: alb.alb,
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
