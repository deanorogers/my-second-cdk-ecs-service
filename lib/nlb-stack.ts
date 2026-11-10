import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import { Construct } from 'constructs';

export interface NlbBackend {
  /** Unique, stable name used for construct ids. */
  readonly name: string;
  readonly listener: elbv2.ApplicationListener;
  readonly securityGroup: ec2.ISecurityGroup;
  /** Relative share of traffic; 0 drains the backend. */
  readonly weight: number;
}

export interface NlbStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly backends: NlbBackend[];
  /** Security groups (e.g. the bastion) allowed to call the NLB on port 80. */
  readonly clientSecurityGroups?: ec2.ISecurityGroup[];
}

/*
** Internal NLB that weight-balances across several internal ALBs. Each ALB gets its own
** ALB-type target group and the listener forwards to them by weight.
*/
export class NlbStack extends cdk.Stack {
  public readonly nlb: elbv2.NetworkLoadBalancer;
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NlbStackProps) {
    super(scope, id, props);

    const nlbSg = this.securityGroup = new ec2.SecurityGroup(this, 'NlbSecurityGroup', {
      vpc: props.vpc,
      description: 'Internal NLB: HTTP (80) from allowed clients, outbound to the ALBs only',
      allowAllOutbound: false,
    });
    (props.clientSecurityGroups ?? []).forEach((sg, i) =>
      nlbSg.addIngressRule(sg, ec2.Port.tcp(80), `HTTP from client ${i}`),
    );

    const nlb = this.nlb = new elbv2.NetworkLoadBalancer(this, 'Nlb', {
      vpc: props.vpc,
      internetFacing: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [nlbSg],
    });

    const weighted = props.backends.map((backend) => {
      nlbSg.addEgressRule(backend.securityGroup, ec2.Port.tcp(80), `To ${backend.name} ALB`);

      // Defined here (not via the ALB SG) to avoid a cyclic stack dependency.
      new ec2.CfnSecurityGroupIngress(this, `${backend.name}AlbIngressFromNlb`, {
        groupId: backend.securityGroup.securityGroupId,
        sourceSecurityGroupId: nlbSg.securityGroupId,
        ipProtocol: 'tcp',
        fromPort: 80,
        toPort: 80,
        description: 'HTTP from weighted NLB',
      });

      const targetGroup = new elbv2.NetworkTargetGroup(this, `${backend.name}TargetGroup`, {
        vpc: props.vpc,
        port: 80,
        protocol: elbv2.Protocol.TCP,
        targetType: elbv2.TargetType.ALB,
        targets: [new targets.AlbListenerTarget(backend.listener)],
        healthCheck: {
          protocol: elbv2.Protocol.HTTP,
          path: '/',
          healthyHttpCodes: '200',
        },
      });
      return { targetGroup, weight: backend.weight };
    });

    nlb.addListener('TcpListener', {
      port: 80,
      defaultAction: elbv2.NetworkListenerAction.weightedForward(weighted),
    });

    new cdk.CfnOutput(this, 'NlbDnsName', { value: nlb.loadBalancerDnsName });
  }
}
