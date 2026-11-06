import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as vpclattice from 'aws-cdk-lib/aws-vpclattice';
import { Construct } from 'constructs';

export const IMAGE_TAG_PARAM_NAME = '/my-second-cdk-ecs-service/image-tag';

export interface FoundationStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
}

export class FoundationStack extends cdk.Stack {
  public readonly serviceNetwork: vpclattice.CfnServiceNetwork;

  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);

    // this will store the image tag to deploy, which is updated by the app pipeline
    const imageTag = new ssm.StringParameter(this, 'ImageTagParameter', {
      parameterName: IMAGE_TAG_PARAM_NAME,
      stringValue: "bootstrap",
      description: 'ECR image tag currently deployed. Updated by the app pipeline.',
    });

    // Logical network that Lattice services and VPCs are associated with.
    this.serviceNetwork = new vpclattice.CfnServiceNetwork(this, 'ServiceNetwork', {
      name: 'my-second-cdk-ecs-service-network',
      authType: 'NONE',
    });

    new vpclattice.CfnServiceNetworkVpcAssociation(this, 'ServiceNetworkVpcAssociation', {
      serviceNetworkIdentifier: this.serviceNetwork.attrId,
      vpcIdentifier: props.vpc.vpcId,
    });

    new cdk.CfnOutput(this, 'ServiceNetworkArn', { value: this.serviceNetwork.attrArn });
    new cdk.CfnOutput(this, 'ServiceNetworkId', { value: this.serviceNetwork.attrId });
  }
}
