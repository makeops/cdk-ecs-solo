import { resolve } from 'path';
import { Duration } from 'aws-cdk-lib';
import { Port, SecurityGroup, Vpc } from 'aws-cdk-lib/aws-ec2';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface SoloClusterControlPlaneProps {
  readonly clusterName: string;
  readonly clusterSecurityGroup: SecurityGroup;
  readonly caddyConfigBucket: string;
  readonly caddyConfigKey: string;
}

export class SoloClusterControlPlane extends Construct {

  public readonly controlPlane: Function;

  public readonly provider: Provider;

  constructor(scope: Construct, id: string, props: SoloClusterControlPlaneProps) {
    super(scope, id);

    const { clusterName, clusterSecurityGroup, caddyConfigBucket, caddyConfigKey } = props;

    const vpc = Vpc.fromLookup(this, `${id}/vpc`, {
      isDefault: true,
    });

    const securityGroup = new SecurityGroup(this, `${id}/security_group`, {
      vpc,
      description: 'Security group for the control plane',
      allowAllOutbound: true,
    });

    clusterSecurityGroup.connections.allowFrom(securityGroup, Port.tcp(2019), 'Allow Caddy Management traffic');

    const controlPlane = new NodejsFunction(this, `${id}/control_plane/function`, {
      entry: resolve(__dirname, '..', 'src', 'control-plane', 'index.mts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      timeout: Duration.seconds(30),
      environment: {
        CLUSTER_NAME: clusterName,
        CADDY_CONFIG_BUCKET: caddyConfigBucket,
        CADDY_CONFIG_KEY: caddyConfigKey,
      },
      bundling: {
        minify: true,
      },
      vpc,
      securityGroups: [securityGroup],
      allowPublicSubnet: true,
    });

    const caddyConfig = Bucket.fromBucketName(this, `${id}/caddy_config_bucket`, caddyConfigBucket);
    caddyConfig.grantReadWrite(controlPlane, caddyConfigKey);

    controlPlane.addToRolePolicy(new PolicyStatement({
      actions: [
        'servicediscovery:DiscoverInstances',
        'servicediscovery:GetNamespace',
        'servicediscovery:ListServices',
      ],
      resources: ['*'],
    }));

    this.controlPlane = controlPlane as Function;

    this.provider = new Provider(this, `${id}--control-plane--provider`, {
      onEventHandler: controlPlane,
    });

  }
}
