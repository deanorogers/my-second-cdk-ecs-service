import * as cdk from 'aws-cdk-lib/core';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

export interface EcsServiceStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly albSecurityGroup: ec2.ISecurityGroup;
  readonly targetGroup: elbv2.ApplicationTargetGroup;
  readonly alternateTargetGroup: elbv2.ApplicationTargetGroup;
  readonly productionListenerRule: elbv2.ApplicationListenerRule;
}

export class EcsServiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EcsServiceStackProps) {
    super(scope, id, props);

    const repository = new ecr.Repository(this, 'AppRepository', {
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      lifecycleRules: [{ maxImageCount: 20, description: 'Keep the last 20 images' }],
    });

    // Resolved by CloudFormation at deploy time. The app repo's pipeline updates this SSM
    // parameter with the tag it deploys, so infra-only deploys keep the current image.
//     const imageTagParam = new cdk.CfnParameter(this, 'MyImageTag', {
//       type: 'AWS::SSM::Parameter::Value<String>',
//       description: 'SSM parameter name holding the ECR image tag to deploy',
//       default: '/my-second-cdk-ecs-service/image-tag',
//     });

    new cdk.CfnOutput(this, 'RepositoryUri', { value: repository.repositoryUri });
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc: props.vpc });

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', { cpu: 256, memoryLimitMiB: 512 });
    taskDef.addContainer('web', {
      image: ecs.ContainerImage.fromEcrRepository(repository, "bootstrap"), // imageTagParam.valueAsString),
      environment: { INJECT_TOKEN: '10' },
      portMappings: [{ containerPort: 80 }],
//       healthCheck: {
//         // Requires curl in the image; healthy only on an exact 200 from the root path.
//         command: ['CMD-SHELL', `[ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost/)" = "200" ] || exit 1`],
//         interval: cdk.Duration.seconds(15),
//         timeout: cdk.Duration.seconds(5),
//         retries: 1,
//         startPeriod: cdk.Duration.seconds(15),
//       },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'web' })
    });
    repository.grantPull(taskDef.obtainExecutionRole());

    const serviceSg = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', {
      vpc: props.vpc,
      description: 'ECS service: HTTP from ALB only',
    });
    serviceSg.addIngressRule(props.albSecurityGroup, ec2.Port.tcp(80), 'HTTP from ALB');

    // ECS watches these through the whole canary (step bake + final bake) and rolls back if any fires.
    // They only reference the target groups in AlbStack, so there is no cycle with the service.
    const alarmFor = (id: string, tg: elbv2.ApplicationTargetGroup) =>
      new cloudwatch.Alarm(this, id, {
        metric: tg.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
          period: cdk.Duration.minutes(1),
          statistic: 'Sum',
        }),
        threshold: 5,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    const deploymentAlarms = [
      alarmFor('PrimaryTarget5xxAlarm', props.targetGroup),
      alarmFor('AlternateTarget5xxAlarm', props.alternateTargetGroup),
    ];

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: taskDef,
      taskDefinitionRevision: ecs.TaskDefinitionRevision.LATEST,
      desiredCount: 3,
      securityGroups: [serviceSg],
      // Native ECS canary (no CodeDeploy): shift 20% of traffic first, bake, then the rest.
      deploymentStrategy: ecs.DeploymentStrategy.CANARY,
      canaryConfiguration: {
        stepPercent: 20,
        stepBakeTime: cdk.Duration.minutes(1),
      },
      bakeTime: cdk.Duration.minutes(1),
      circuitBreaker: { rollback: true },
      deploymentAlarms: {
        alarmNames: deploymentAlarms.map((a) => a.alarmName),
        behavior: ecs.AlarmBehavior.ROLLBACK_ON_ALARM,
      },
    });

    props.targetGroup.addTarget(
      service.loadBalancerTarget({
        containerName: 'web',
        containerPort: 80,
        alternateTarget: new ecs.AlternateTarget('AlternateTarget', {
          alternateTargetGroup: props.alternateTargetGroup,
          productionListener: ecs.ListenerRuleConfiguration.applicationListenerRule(
            props.productionListenerRule,
          ),
        }),
      }),
    );
  }
}
