import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Construct } from 'constructs';

export interface ApiGatewayStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly albSecurityGroup: ec2.ISecurityGroup;
  readonly listener: elbv2.ApplicationListener;
}

export class ApiGatewayStack extends cdk.Stack {
  public readonly api: apigateway.SpecRestApi;

  constructor(scope: Construct, id: string, props: ApiGatewayStackProps) {
    super(scope, id, props);

    // REST API VPC links can only target an NLB, so an internal NLB fronts the internal ALB.
    // CDK would otherwise auto-create an NLB security group with no usable egress.
    const nlbSg = new ec2.SecurityGroup(this, 'NlbSecurityGroup', {
      vpc: props.vpc,
      description: 'Internal NLB: outbound to the ALB on port 80 only',
      allowAllOutbound: false,
    });
    nlbSg.addEgressRule(props.albSecurityGroup, ec2.Port.tcp(80), 'To ALB');

    const nlb = new elbv2.NetworkLoadBalancer(this, 'Nlb', {
      vpc: props.vpc,
      internetFacing: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [nlbSg],
      // The API Gateway VPC link reaches the NLB over PrivateLink; don't require inbound rules for it.
      enforceSecurityGroupInboundRulesOnPrivateLinkTraffic: false,
    });
    nlb.addListener('TcpListener', { port: 80 }).addTargets('AlbTarget', {
      port: 80,
      targets: [new targets.AlbListenerTarget(props.listener)],
      healthCheck: {
        protocol: elbv2.Protocol.HTTP,
        path: '/healthz', // fixed response from the ALB listener, independent of ECS
        healthyHttpCodes: '200',
      },
    });

    // Defined here (not via albSecurityGroup.addIngressRule) to avoid a cyclic stack dependency.
    new ec2.CfnSecurityGroupIngress(this, 'AlbIngressFromNlb', {
      groupId: props.albSecurityGroup.securityGroupId,
      sourceSecurityGroupId: nlbSg.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 80,
      toPort: 80,
      description: 'HTTP from internal NLB (API Gateway VPC link)',
    });

    const vpcLink = new apigateway.VpcLink(this, 'VpcLink', { targets: [nlb] });

    // The contract stays clean/portable; the VPC link and NLB target are deploy-time tokens,
    // so the API Gateway extensions are injected here.
    const spec = yaml.load(
      fs.readFileSync(path.join(__dirname, 'contracts', 'accounts.openapi.yaml'), 'utf8'),
    ) as Record<string, any>;

    spec['x-amazon-apigateway-request-validators'] = {
      all: { validateRequestBody: true, validateRequestParameters: true },
    };
    spec['x-amazon-apigateway-request-validator'] = 'all';

    const httpMethods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];
    for (const [route, pathItem] of Object.entries<Record<string, any>>(spec.paths)) {
      const pathParams = [...route.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      for (const method of httpMethods) {
        if (!pathItem[method]) continue;
        pathItem[method]['x-amazon-apigateway-integration'] = {
          type: 'http_proxy',
          httpMethod: method.toUpperCase(),
          uri: `http://${nlb.loadBalancerDnsName}${route}`,
          connectionType: 'VPC_LINK',
          connectionId: vpcLink.vpcLinkId,
          requestParameters: Object.fromEntries(
            pathParams.map((p) => [`integration.request.path.${p}`, `method.request.path.${p}`]),
          ),
        };
      }
    }

    const accessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.api = new apigateway.SpecRestApi(this, 'MyApi', {
      apiDefinition: apigateway.ApiDefinition.fromInline(spec),
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      cloudWatchRole: true, // account-level role API Gateway needs to write execution logs
      deployOptions: {
        stageName: 'prod',
        loggingLevel: apigateway.MethodLoggingLevel.INFO, // execution logs
        dataTraceEnabled: true, // log full request/response bodies (disable once debugged)
        metricsEnabled: true,
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogs),
        accessLogFormat: apigateway.AccessLogFormat.custom(
          JSON.stringify({
            requestId: '$context.requestId',
            ip: '$context.identity.sourceIp',
            method: '$context.httpMethod',
            path: '$context.path',
            status: '$context.status',
            responseLength: '$context.responseLength',
            latencyMs: '$context.responseLatency',
            integrationStatus: '$context.integration.status',
            integrationLatencyMs: '$context.integration.latency',
            integrationError: '$context.integration.error',
            errorMessage: '$context.error.message',
            errorType: '$context.error.responseType',
          }),
        ),
      },
    });

    new cdk.CfnOutput(this, 'ApiUrl', { value: this.api.url });
  }
}

