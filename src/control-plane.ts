import { resolve } from 'path';
import { SecurityGroup, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { Provider } from 'aws-cdk-lib/custom-resources';

export interface SoloClusterControlPlaneProps {
  readonly clusterName: string;
}

export class SoloClusterControlPlane extends Construct {

  public readonly controlPlane: Function;

  public readonly provider: Provider;

  constructor(scope: Construct, id: string, props: SoloClusterControlPlaneProps) {
    super(scope, id);

    const { clusterName } = props;

    const vpc = Vpc.fromLookup(this, `${id}/vpc`, {
      isDefault: true,
    });

    const securityGroup = new SecurityGroup(this, `${id}/security_group`, {
      vpc,
      description: 'Security group for the control plane',
      allowAllOutbound: true,
    });

    const controlPlane = new NodejsFunction(this, `${id}/control_plane/function`, {
      entry: resolve(__dirname, '..', 'src', 'control-plane', 'index.mts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      environment: {
        CLUSTER_NAME: clusterName,
      },
      bundling: {
        minify: true,
      },
      vpc,
      securityGroups: [securityGroup],
      allowPublicSubnet: true,
    });

    this.controlPlane = controlPlane as Function;

    this.provider = new Provider(this, `${id}--control-plane--provider`, {
      onEventHandler: controlPlane,
    })

  }
}
