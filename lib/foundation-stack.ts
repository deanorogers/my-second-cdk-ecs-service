import * as cdk from 'aws-cdk-lib/core';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export const IMAGE_TAG_PARAM_NAME = '/my-second-cdk-ecs-service/image-tag';

export class FoundationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

//     const initialTag = new cdk.CfnParameter(this, 'InitialImageTag', {
//       type: 'String',
//       description: 'Image tag to seed the SSM parameter with; only used on creation',
//     });

    const imageTag = new ssm.StringParameter(this, 'ImageTagParameter', {
      parameterName: IMAGE_TAG_PARAM_NAME,
      stringValue: "bootstrap",
      description: 'ECR image tag currently deployed. Updated by the app pipeline.',
    });
//     imageTag.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
  }
}
