import * as cdk from 'aws-cdk-lib/core';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as vpclattice from 'aws-cdk-lib/aws-vpclattice';
import { Construct } from 'constructs';
import { IMAGE_TAG_PARAM_NAME } from './foundation-stack';

export interface EcsServiceStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly alb: elbv2.IApplicationLoadBalancer;
  readonly albSecurityGroup: ec2.ISecurityGroup;
  readonly serviceNetwork: vpclattice.CfnServiceNetwork;
  readonly targetGroup: elbv2.ApplicationTargetGroup;
  readonly alternateTargetGroup: elbv2.ApplicationTargetGroup;
  readonly productionListenerRule: elbv2.ApplicationListenerRule;
}
/*
** When infra initially deploys, ensure desireCount is zero so the service doesn't start until the image is built, pushed to ECR and its tag stored in Parameter Store
*/
export class EcsServiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EcsServiceStackProps) {
    super(scope, id, props);
    const repository = new ecr.Repository(this, 'AppRepository', {
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      lifecycleRules: [{ maxImageCount: 20, description: 'Keep the last 20 images' }],
    });

    // read the image tag to deploy from SSM
    // which is set by the app pipeline
    const imageTagParam = new cdk.CfnParameter(this, 'MyImageTag', {
      type: 'AWS::SSM::Parameter::Value<String>',
      default: IMAGE_TAG_PARAM_NAME,
    });

    new cdk.CfnOutput(this, 'RepositoryUri', { value: repository.repositoryUri });
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc: props.vpc });

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', { cpu: 256, memoryLimitMiB: 512 });
    taskDef.addContainer('web', {
      image: ecs.ContainerImage.fromEcrRepository(repository, imageTagParam.valueAsString),
      environment: {
          INJECT_TOKEN: '10',
          DEPLOY_DATE: '5-NOV-22:01'
      },
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
      desiredCount: 5,
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

    // Expose the service on the Lattice service network by forwarding to the internal ALB, so
    // the ECS canary (which shifts weights on the ALB listener rule) works unchanged behind Lattice.
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
    // Separate rule (not inline on the ALB SG), matching how other consumers add ingress.
    new ec2.CfnSecurityGroupIngress(this, 'LatticeToAlbIngress', {
      groupId: props.albSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 80,
      toPort: 80,
      sourcePrefixListId: latticePrefixList.getResponseField('PrefixLists.0.PrefixListId'),
      description: 'HTTP from VPC Lattice',
    });

    const latticeTargetGroup = new vpclattice.CfnTargetGroup(this, 'LatticeTargetGroup', {
      name: 'ecs-service-alb',
      type: 'ALB',
      config: {
        port: 80,
        protocol: 'HTTP',
        protocolVersion: 'HTTP1',
        vpcIdentifier: props.vpc.vpcId,
      },
      targets: [{ id: props.alb.loadBalancerArn, port: 80 }],
    });

    const latticeService = new vpclattice.CfnService(this, 'LatticeService', {
      name: 'ecs-service',
      authType: 'NONE',
    });

    new vpclattice.CfnListener(this, 'LatticeListener', {
      serviceIdentifier: latticeService.attrId,
      protocol: 'HTTP',
      port: 80,
      defaultAction: {
        forward: { targetGroups: [{ targetGroupIdentifier: latticeTargetGroup.attrId }] },
      },
    });

    new vpclattice.CfnServiceNetworkServiceAssociation(this, 'LatticeServiceAssociation', {
      serviceIdentifier: latticeService.attrId,
      serviceNetworkIdentifier: props.serviceNetwork.attrId,
    });

    new cdk.CfnOutput(this, 'LatticeServiceDnsName', {
      value: latticeService.attrDnsEntryDomainName,
    });
  }
}
