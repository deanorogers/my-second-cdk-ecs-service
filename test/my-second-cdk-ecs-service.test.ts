import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AlbStack } from '../lib/alb-stack';
import { EcsServiceStack } from '../lib/ecs-service-stack';

test('ALB SG only allows HTTP from allowed CIDR', () => {
  const app = new cdk.App();
  const alb = new AlbStack(app, 'Alb', undefined);
  const svc = new EcsServiceStack(app, 'Svc', {
    vpc: alb.vpc,
    albSecurityGroup: alb.albSecurityGroup,
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
  Template.fromStack(svc).hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: 'web',
        Image: {
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([Match.stringLikeRegexp(':bootstrap$')]),
          ]),
        },
      }),
    ]),
  });
});
