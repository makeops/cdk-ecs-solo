import { join } from 'path';
import { Tags } from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import { SoloClusterControlPlane } from './control-plane';

export interface SoloEC2ClusterProps {
  readonly clusterName: string;
  readonly instanceType?: ec2.InstanceType;
  readonly architecture?: ec2.InstanceArchitecture;
  readonly enableSsm?: boolean;
}


export class SoloEC2Cluster extends Construct {

  private readonly clusterName: string;
  private readonly id: string;
  public controlPlane?: SoloClusterControlPlane;
  public readonly namespace: servicediscovery.HttpNamespace;
  public readonly clusterSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: SoloEC2ClusterProps) {
    super(scope, id);

    const {
      clusterName,
      instanceType,
      architecture,
      enableSsm = true,
    } = props;

    this.clusterName = clusterName;
    this.id = id;

    const namespace = new servicediscovery.HttpNamespace(this, `${id}--namespace`, {
      name: 'solo.local',
    });

    this.namespace = namespace;

    const vpc = ec2.Vpc.fromLookup(this, `${id}/vpc`, {
      isDefault: true,
    });

    new ecs.CfnCluster(this, `${id}/cluster`, {
      clusterName,
    });

    const userData = ec2.UserData.forLinux();

    userData.addCommands(
      `echo "ECS_CLUSTER=${clusterName}" >> /etc/ecs/ecs.config`,
    );

    const machineImageSsmParameter = architecture === ec2.InstanceArchitecture.ARM_64
      ? '/aws/service/ecs/optimized-ami/amazon-linux-2023/arm64/recommended/image_id'
      : '/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id';

    const instanceClass = architecture === ec2.InstanceArchitecture.ARM_64
      ? ec2.InstanceClass.T4G
      : ec2.InstanceClass.T3;

    const instanceRole = new iam.Role(this, `${id}/instance_role`, {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });

    instanceRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role'));

    if (enableSsm) {
      instanceRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
    }

    const instanceSecurityGroup = new ec2.SecurityGroup(this, `${id}/instance_security_group`, {
      vpc,
      description: 'Security group for the instance',
      allowAllOutbound: true,
    });

    this.clusterSecurityGroup = instanceSecurityGroup;

    const launchTemplate = new ec2.LaunchTemplate(this, `${id}/launch_template`, {
      machineImage: ec2.MachineImage.fromSsmParameter(machineImageSsmParameter),
      instanceType: instanceType ?? ec2.InstanceType.of(instanceClass, ec2.InstanceSize.SMALL),
      userData,
      role: instanceRole,
      securityGroup: instanceSecurityGroup,
    });

    instanceSecurityGroup.connections.allowFromAnyIpv4(ec2.Port.tcp(80), 'Allow HTTP traffic');
    instanceSecurityGroup.connections.allowFromAnyIpv4(ec2.Port.tcp(443), 'Allow HTTPS traffic');

    Tags.of(launchTemplate).add('Name', `${clusterName}-node`);

    const asg = new autoscaling.AutoScalingGroup(this, `${id}/auto_scaling_group`, {
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
      launchTemplate,
      minCapacity: 1,
      autoScalingGroupName: `${clusterName}-solo-asg`,
    });

    Tags.of(asg).add('Name', `${clusterName}-asg`, { applyToLaunchedInstances: true });

    this.enableLoadBalancer(namespace);

  }

  enableLoadBalancer(namespace: servicediscovery.HttpNamespace) {

    const taskDefinition = new ecs.Ec2TaskDefinition(this, `${this.id}/task_definition`, {
      family: `${this.clusterName}-ingress`,
      networkMode: ecs.NetworkMode.BRIDGE,
    });

    const defaultCaddyConfig = new Asset(this, `${this.id}/default_caddyfile`, {
      path: join(__dirname, '..', 'src', 'assets', 'caddy_config.json'),
    });

    taskDefinition.addVolume({
      name: 'caddy_config',
    });

    defaultCaddyConfig.grantRead(taskDefinition.taskRole);

    const loadCaddyConfig = taskDefinition.addContainer('load-config', {
      essential: false,
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/aws-cli/aws-cli:latest'),
      cpu: 0,
      memoryReservationMiB: 128,
      command: [
        's3',
        'cp',
        `s3://${defaultCaddyConfig.s3BucketName}/${defaultCaddyConfig.s3ObjectKey}`,
        '/tmp/config/caddy_config.json',
      ],
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: 'load-caddy-config',
        logRetention: RetentionDays.ONE_MONTH,
      }),
    });

    loadCaddyConfig.addMountPoints({
      sourceVolume: 'caddy_config',
      containerPath: '/tmp/config',
      readOnly: false,
    });

    const caddy = taskDefinition.addContainer('caddy', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/caddy:2-alpine'),
      essential: true,
      cpu: 0,
      memoryReservationMiB: 128,
      command: [
        'caddy',
        'run',
        '--config',
        '/tmp/config/caddy_config.json',
      ],
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: 'caddy',
        logRetention: RetentionDays.ONE_MONTH,
      }),
    });

    caddy.addContainerDependencies({
      container: loadCaddyConfig,
      condition: ecs.ContainerDependencyCondition.COMPLETE,
    });

    caddy.addMountPoints({
      sourceVolume: 'caddy_config',
      containerPath: '/tmp/config',
      readOnly: true,
    });

    caddy.addPortMappings({
      containerPort: 80,
      hostPort: 80,
    });

    caddy.addPortMappings({
      containerPort: 443,
      hostPort: 443,
    });

    caddy.addPortMappings({
      containerPort: 2019,
      hostPort: 2019,
    });

    new ecs.CfnService(this, `${this.id}/ingress`, {
      availabilityZoneRebalancing: ecs.AvailabilityZoneRebalancing.DISABLED,
      cluster: this.clusterName,
      desiredCount: 1,
      serviceName: `${this.clusterName}-ingress`,
      taskDefinition: taskDefinition.taskDefinitionArn,
      deploymentConfiguration: {
        minimumHealthyPercent: 0,
        maximumPercent: 100,
      },
      serviceConnectConfiguration: {
        enabled: true,
        namespace: namespace.namespaceArn,
      },
    });

  }

}
