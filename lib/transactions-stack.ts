import * as cdk from 'aws-cdk-lib/core';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { TRANSACTIONS_IMAGE_TAG_PARAM_NAME } from './foundation-stack';

export interface TransactionsStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  /** Security groups (e.g. the bastion) allowed to call the ALB on port 80. */
  readonly clientSecurityGroups?: ec2.ISecurityGroup[];
  /** Passed to the container as INSTANCE_NAME so the app can vary its response per instance. */
  readonly instanceName?: string;
  /** Reuse an existing ECR repository (e.g. from another instance) instead of creating one. */
  readonly repository?: ecr.IRepository;
}

/*
** Transactions service: its own internal ALB, ECR repo and ECS service, using the same
** native ECS canary pattern as the accounts service. Not yet published through API Gateway.
** desiredCount starts at 0 so the service doesn't try to pull an image that hasn't been pushed;
** raise it once the image is in ECR and its tag is stored in Parameter Store.
*/
export class TransactionsStack extends cdk.Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly albSecurityGroup: ec2.SecurityGroup;
  public readonly listener: elbv2.ApplicationListener;
  public readonly repository: ecr.IRepository;

  constructor(scope: Construct, id: string, props: TransactionsStackProps) {
    super(scope, id, props);

    const repository = this.repository = props.repository ?? new ecr.Repository(this, 'TransactionsRepository', {
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      lifecycleRules: [{ maxImageCount: 20, description: 'Keep the last 20 images' }],
    });

    // Image tag to deploy, set by the transactions app pipeline.
    const imageTagParam = new cdk.CfnParameter(this, 'MyImageTag', {
      type: 'AWS::SSM::Parameter::Value<String>',
      default: TRANSACTIONS_IMAGE_TAG_PARAM_NAME,
    });

    const albSecurityGroup = this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: props.vpc,
      description: 'Internal transactions ALB: HTTP (80) from allowed security groups only',
      allowAllOutbound: true,
    });
    (props.clientSecurityGroups ?? []).forEach((sg, i) =>
      new ec2.CfnSecurityGroupIngress(this, `AlbIngressFromClient${i}`, {
        groupId: albSecurityGroup.securityGroupId,
        sourceSecurityGroupId: sg.securityGroupId,
        ipProtocol: 'tcp',
        fromPort: 80,
        toPort: 80,
        description: 'HTTP from client',
      }),
    );

    const alb = this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: false,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // Canary deployments need a primary and an alternate target group.
    const tgProps: elbv2.ApplicationTargetGroupProps = {
      vpc: props.vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: { path: '/' },
    };
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', tgProps);
    const alternateTargetGroup = new elbv2.ApplicationTargetGroup(this, 'AlternateTargetGroup', tgProps);

    const listener = this.listener = alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false, // SG already restricts access
      defaultAction: elbv2.ListenerAction.fixedResponse(404, { messageBody: 'Not found' }),
    });

    // Production rule that ECS shifts traffic on during canary deployments.
    const productionListenerRule = new elbv2.ApplicationListenerRule(this, 'ProductionRule', {
      listener,
      priority: 1,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/*'])],
      action: elbv2.ListenerAction.weightedForward([
        { targetGroup, weight: 100 },
        { targetGroup: alternateTargetGroup, weight: 0 },
      ]),
    });

    const cluster = new ecs.Cluster(this, 'Cluster', { vpc: props.vpc });

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', { cpu: 256, memoryLimitMiB: 512 });
    taskDef.addContainer('transactions', {
      image: ecs.ContainerImage.fromEcrRepository(repository, imageTagParam.valueAsString),
      environment: { INSTANCE_NAME: props.instanceName ?? 'primary' },
      portMappings: [{ containerPort: 80 }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'transactions' }),
    });
    repository.grantPull(taskDef.obtainExecutionRole());

    const serviceSg = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', {
      vpc: props.vpc,
      description: 'Transactions ECS service: HTTP from ALB only',
    });
    serviceSg.addIngressRule(albSecurityGroup, ec2.Port.tcp(80), 'HTTP from ALB');

    // ECS watches these through the whole canary (step bake + final bake) and rolls back if any fires.
    const alarmFor = (alarmId: string, tg: elbv2.ApplicationTargetGroup) =>
      new cloudwatch.Alarm(this, alarmId, {
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
      alarmFor('PrimaryTarget5xxAlarm', targetGroup),
      alarmFor('AlternateTarget5xxAlarm', alternateTargetGroup),
    ];

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: taskDef,
      taskDefinitionRevision: ecs.TaskDefinitionRevision.LATEST,
      desiredCount: 4,
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

    targetGroup.addTarget(
      service.loadBalancerTarget({
        containerName: 'transactions',
        containerPort: 80,
        alternateTarget: new ecs.AlternateTarget('AlternateTarget', {
          alternateTargetGroup,
          productionListener: ecs.ListenerRuleConfiguration.applicationListenerRule(productionListenerRule),
        }),
      }),
    );

    if (!props.repository) {
      new cdk.CfnOutput(this, 'RepositoryUri', { value: repository.repositoryUri });
    }
    new cdk.CfnOutput(this, 'AlbDnsName', { value: alb.loadBalancerDnsName });
  }
}
