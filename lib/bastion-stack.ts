import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface BastionStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly albSecurityGroup: ec2.ISecurityGroup;
}

export class BastionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BastionStackProps) {
    super(scope, id, props);

    const bastionSg = new ec2.SecurityGroup(this, 'BastionSecurityGroup', {
      vpc: props.vpc,
      description: 'Bastion: no inbound; outbound allowed (reaches ALB)',
      allowAllOutbound: true,
    });

    const bastion = new ec2.Instance(this, 'Bastion', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }, // SSM via NAT
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: bastionSg,
      requireImdsv2: true,
    });
    // Access via SSM Session Manager (no SSH port open).
    bastion.role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
    );

    // Defined in this stack (not via albSecurityGroup.addIngressRule) so AlbStack
    // does not depend on BastionStack, which would create a cyclic dependency.
    new ec2.CfnSecurityGroupIngress(this, 'AlbIngressFromBastion', {
      groupId: props.albSecurityGroup.securityGroupId,
      sourceSecurityGroupId: bastionSg.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 80,
      toPort: 80,
      description: 'HTTP from bastion',
    });

    new cdk.CfnOutput(this, 'BastionInstanceId', { value: bastion.instanceId });
  }
}

