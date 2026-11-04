# Welcome to your CDK TypeScript project

This is a blank project for CDK development with TypeScript.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

* `npm run build`   type-check the project
* `npm run watch`   watch for changes and type-check
* `npm run test`    perform the jest unit tests
* `npx cdk deploy EcsServiceStack` deploy using the image tag stored in SSM parameter `/my-second-cdk-ecs-service/image-tag`
  (the app repo's pipeline must update it after each image deploy; seed it once with
  `aws ssm put-parameter --name /my-second-cdk-ecs-service/image-tag --type String --value <existing-tag>`)
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template
