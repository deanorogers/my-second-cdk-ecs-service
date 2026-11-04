import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

export class AlbStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly albSecurityGroup: ec2.SecurityGroup;
  public readonly listener: elbv2.ApplicationListener;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;
  public readonly alternateTargetGroup: elbv2.ApplicationTargetGroup;
  public readonly productionListenerRule: elbv2.ApplicationListenerRule;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'Vpc', { maxAzs: 2, natGateways: 1 });

    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: this.vpc,
      description: 'Internal ALB: HTTP (80) from allowed security groups only',
      allowAllOutbound: true,
    });
    // Ingress rules are added by consumers (e.g. BastionStack) as separate rules.

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: this.vpc,
      internetFacing: false,
      securityGroup: this.albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // Target groups live here so the ECS stack only depends on this stack (no cycles).
    // Canary deployments need a primary and an alternate target group.
    const tgProps: elbv2.ApplicationTargetGroupProps = {
      vpc: this.vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: { path: '/' },
    };
    this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', tgProps);
    this.alternateTargetGroup = new elbv2.ApplicationTargetGroup(this, 'AlternateTargetGroup', tgProps);

    const listener = this.listener = this.alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false, // SG already restricts access
      defaultAction: elbv2.ListenerAction.fixedResponse(404, { messageBody: 'Not found' }),
    });

    // Production rule that ECS shifts traffic on during canary deployments.
    // Priority 2 so the fixed-response health rule (priority 1) is evaluated first.
    this.productionListenerRule = new elbv2.ApplicationListenerRule(this, 'ProductionRule', {
      listener,
      priority: 2,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/*'])],
      action: elbv2.ListenerAction.weightedForward([
        { targetGroup: this.targetGroup, weight: 100 },
        { targetGroup: this.alternateTargetGroup, weight: 0 },
      ]),
    });

    // Health endpoint for the NLB in front of this ALB: answered by the ALB itself so the
    // NLB health check doesn't depend on the ECS service. Depends on the production rule so
    // CloudFormation moves that rule to priority 2 before this one takes priority 1.
    const healthRule = new elbv2.ApplicationListenerRule(this, 'HealthRule', {
      listener,
      priority: 1,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/healthz'])],
      action: elbv2.ListenerAction.fixedResponse(200, {
        contentType: 'text/plain',
        messageBody: 'OK',
      }),
    });
    healthRule.node.addDependency(this.productionListenerRule);

    new cdk.CfnOutput(this, 'AlbDnsName', { value: this.alb.loadBalancerDnsName });
  }
}
