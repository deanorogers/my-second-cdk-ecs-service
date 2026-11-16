# Welcome to your CDK TypeScript project

This is a blank project for CDK development with TypeScript.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

`TransactionsDnsStack` creates a private `red.com` hosted zone associated with the
application VPC. Two weighted A alias records for `transactions.red.com` point to
the Green and Blue internal Transactions ALBs (50/50, configured in
`bin/my-second-cdk-ecs-service.ts`). The accounts ECS container receives
`TRANSACTIONS_BASE_URL=http://transactions.red.com` and can reach both ALBs on port 80.
Alias target health evaluation is enabled. DNS caching and connection reuse mean
the weights do not guarantee a matching split of individual HTTP requests.
The private zone is authoritative for `red.com` inside this VPC; other names under
that domain need records in this zone to resolve there.

Deploy with `npx cdk deploy EcsServiceStack` (including its dependencies).

## Useful commands

* `npm run build`   type-check the project
* `npm run watch`   watch for changes and type-check
* `npm run test`    perform the jest unit tests
* `npx cdk deploy EcsServiceStack` deploy using the image tag stored in SSM parameter `/my-second-cdk-ecs-service/image-tag`
  (the app repo's pipeline must update it after each image deploy; seed it once with
  `aws ssm put-parameter --name /my-second-cdk-ecs-service/image-tag --type String --value <existing-tag>`)
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template
