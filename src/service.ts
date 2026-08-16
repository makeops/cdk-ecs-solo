import { CustomResource } from 'aws-cdk-lib';
import { AvailabilityZoneRebalancing, CfnService, ContainerImage, Ec2TaskDefinition, LogDriver, Protocol, Secret } from 'aws-cdk-lib/aws-ecs';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { HttpNamespace } from 'aws-cdk-lib/aws-servicediscovery';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface SoloEc2ServiceProps {
  readonly serviceName: string;
  readonly image: ContainerImage;
  readonly clusterName: string;
  readonly externalPort?: number;
  readonly environment?: { [key: string]: string };
  readonly secrets?: { [key: string]: Secret };
  readonly namespace: HttpNamespace;
}

export class SoloEc2Service extends Construct {
  constructor(scope: Construct, id: string, props: SoloEc2ServiceProps) {
    super(scope, id);

    const {
      serviceName,
      image,
      clusterName,
      externalPort = 8000,
      environment,
      secrets,
      namespace,
    } = props;

    const taskDefinition = new Ec2TaskDefinition(this, `${id}--task-def`, {
      family: `${serviceName}`,
    });

    taskDefinition.addContainer('main', {
      image,
      cpu: 0,
      memoryReservationMiB: 128,
      logging: LogDriver.awsLogs({
        streamPrefix: `${serviceName}`,
        logRetention: RetentionDays.ONE_MONTH,
      }),
      portMappings: [
        {
          containerPort: externalPort,
          name: 'exposed-port',
          protocol: Protocol.TCP,
        },
      ],
      ...(environment ? { environment } : {}),
      ...(secrets ? { secrets } : {}),
    });

    new CfnService(this, `${id}--0`, {
      cluster: clusterName,
      serviceName: `${clusterName}-${serviceName}`,
      taskDefinition: taskDefinition.taskDefinitionArn,
      availabilityZoneRebalancing: AvailabilityZoneRebalancing.DISABLED,
      desiredCount: 1,
      deploymentConfiguration: {
        minimumHealthyPercent: 100,
        maximumPercent: 200,
      },
      serviceConnectConfiguration: {
        enabled: true,
        namespace: namespace.namespaceArn,
        services: [{
          discoveryName: `${serviceName}`,
          portName: 'exposed-port',
          clientAliases: [{
            port: externalPort,
          }],
        }],
      },
    });

  }
}


export interface SoloExposeServiceProps {
  readonly provider: Provider;
  readonly serviceName: string;
  readonly namespace: HttpNamespace;
  readonly port: number;
  /**
   * Canonical hostname served by Caddy (the final server name).
   */
  readonly domain: string;
  /**
   * Extra hostnames that 308-redirect to `domain`.
   */
  readonly additionalDomains?: string[];
}

export class SoloExposeService extends Construct {
  constructor(scope: Construct, id: string, props: SoloExposeServiceProps) {
    super(scope, id);

    const { provider, serviceName, namespace, port, domain, additionalDomains = [] } = props;

    new CustomResource(this, `${id}--expose-service`, {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::SoloExposeService',
      properties: {
        serviceName,
        namespaceArn: namespace.namespaceArn,
        port,
        domain,
        additionalDomains,
      },
    });

  }
}
