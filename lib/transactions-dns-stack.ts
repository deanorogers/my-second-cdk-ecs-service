import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export interface TransactionsDnsStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly backends: {
    readonly name: string;
    readonly alb: elbv2.IApplicationLoadBalancer;
    readonly weight: number;
  }[];
}

export class TransactionsDnsStack extends cdk.Stack {
  public readonly dnsName = 'transactions.red.com';

  constructor(scope: Construct, id: string, props: TransactionsDnsStackProps) {
    super(scope, id, props);

    const zone = new route53.PrivateHostedZone(this, 'PrivateZone', {
      zoneName: 'red.com',
      vpc: props.vpc,
    });

    for (const backend of props.backends) {
      new route53.CfnRecordSet(this, `${backend.name}WeightedRecord`, {
        hostedZoneId: zone.hostedZoneId,
        name: this.dnsName,
        type: 'A',
        setIdentifier: backend.name,
        weight: backend.weight,
        aliasTarget: {
          dnsName: backend.alb.loadBalancerDnsName,
          hostedZoneId: backend.alb.loadBalancerCanonicalHostedZoneId,
          evaluateTargetHealth: true,
        },
      });
    }

    new cdk.CfnOutput(this, 'TransactionsDnsName', { value: this.dnsName });
  }
}
