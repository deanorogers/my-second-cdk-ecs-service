import * as cdk from 'aws-cdk-lib/core';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as vpclattice from 'aws-cdk-lib/aws-vpclattice';
import { Construct } from 'constructs';

export interface LatticeBackend {
  /** Unique, stable name used for construct ids and target group names. */
  readonly name: string;
  readonly alb: elbv2.IApplicationLoadBalancer;
  readonly securityGroup: ec2.ISecurityGroup;
  /** Relative share of traffic; 0 drains the backend. */
  readonly weight: number;
}

export interface TransactionsLatticeStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly serviceNetwork: vpclattice.CfnServiceNetwork;
  readonly backends: LatticeBackend[];
}

/*
** Registers Transactions on the Lattice service network. ALB-type Lattice target groups point at a
** whole ALB, so the weighted split is between the ALBs of the Transactions instances; ECS canary
** shifting inside each ALB is unchanged.
*/
export class TransactionsLatticeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TransactionsLatticeStackProps) {
    super(scope, id, props);

    // AWS-managed prefix lists can't be resolved by the CDK lookup provider, so ask EC2 at deploy time.
    const latticePrefixList = new cr.AwsCustomResource(this, 'LatticePrefixListLookup', {
      onUpdate: {
        service: 'EC2',
        action: 'describeManagedPrefixLists',
        parameters: {
          Filters: [{ Name: 'prefix-list-name', Values: [`com.amazonaws.${this.region}.vpc-lattice`] }],
        },
        physicalResourceId: cr.PhysicalResourceId.of(`lattice-prefix-list-${this.region}`),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
    });
    const prefixListId = latticePrefixList.getResponseField('PrefixLists.0.PrefixListId');

    // each backend is composed ALB: ARN, SG and weight
    // the weight is set by the app with default equal distribution
    const weighted = props.backends.map((backend) => {
      // Separate rule (not inline on the ALB SG) to avoid a cyclic stack dependency.
      new ec2.CfnSecurityGroupIngress(this, `${backend.name}LatticeToAlbIngress`, {
        groupId: backend.securityGroup.securityGroupId,
        ipProtocol: 'tcp',
        fromPort: 80,
        toPort: 80,
        sourcePrefixListId: prefixListId,
        description: 'HTTP from VPC Lattice',
      });

      const targetGroup = new vpclattice.CfnTargetGroup(this, `${backend.name}LatticeTargetGroup`, {
        name: `transactions-${backend.name.toLowerCase()}-alb`,
        type: 'ALB',
        config: {
          port: 80,
          protocol: 'HTTP',
          protocolVersion: 'HTTP1',
          vpcIdentifier: props.vpc.vpcId,
        },
        targets: [{ id: backend.alb.loadBalancerArn, port: 80 }],
      });
      return { targetGroupIdentifier: targetGroup.attrId, weight: backend.weight };
    });

    const latticeService = new vpclattice.CfnService(this, 'LatticeService', {
      name: 'transactions',
      authType: 'NONE',
    });

    new vpclattice.CfnListener(this, 'LatticeListener', {
      serviceIdentifier: latticeService.attrId,
      protocol: 'HTTP',
      port: 80,
      defaultAction: { forward: { targetGroups: weighted } },
    });

    new vpclattice.CfnServiceNetworkServiceAssociation(this, 'LatticeServiceAssociation', {
      serviceIdentifier: latticeService.attrId,
      serviceNetworkIdentifier: props.serviceNetwork.attrId,
    });

    new cdk.CfnOutput(this, 'TransactionsLatticeServiceDnsName', {
      value: latticeService.attrDnsEntryDomainName,
    });
  }
}
