import { AvailabilityZoneRebalancing, CfnService, ContainerImage, Ec2TaskDefinition, LogDriver, Protocol, Secret } from 'aws-cdk-lib/aws-ecs';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface SoloEc2ServiceProps {
  readonly serviceName: string;
  readonly image: ContainerImage;
  readonly clusterName: string;
  readonly externalPort?: number;
  readonly environment?: { [key: string]: string };
  readonly secrets?: { [key: string]: Secret };
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
        }
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
    });

  }
}


export interface SoloExposeServiceProps {}

export class SoloExposeService extends Construct {
  constructor(scope: Construct, id: string, props: SoloExposeServiceProps) {
    super(scope, id);
  }
}
