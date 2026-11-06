import * as cdk from 'aws-cdk-lib/core';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export const IMAGE_TAG_PARAM_NAME = '/my-second-cdk-ecs-service/image-tag';

export class FoundationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
   });

    // this will store the image tag to deploy, which is updated by the app pipeline
    const imageTag = new ssm.StringParameter(this, 'ImageTagParameter', {
      parameterName: IMAGE_TAG_PARAM_NAME,
      stringValue: "bootstrap",
      description: 'ECR image tag currently deployed. Updated by the app pipeline.',
    });
  }
}
