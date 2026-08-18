import { resolve } from 'path';
import { Duration } from 'aws-cdk-lib';
import { Port, SecurityGroup, Vpc } from 'aws-cdk-lib/aws-ec2';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { DefinitionBody, StateMachine } from 'aws-cdk-lib/aws-stepfunctions';
import { LambdaInvoke } from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';

export interface SoloClusterControlPlaneProps {
  readonly clusterName: string;
  readonly clusterSecurityGroup: SecurityGroup;
  readonly caddyConfigBucket: string;
  readonly caddyConfigKey: string;
}

function handlerEntry(name: string): string {
  return resolve(__dirname, '..', 'src', 'control-plane', `${name}.mts`);
}

export class SoloClusterControlPlane extends Construct {

  public readonly serviceToken: string;

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

    const bundling = { minify: true };
    const workerTimeout = Duration.seconds(30);

    const applyCaddy = new NodejsFunction(this, `${id}/apply_caddy/function`, {
      entry: handlerEntry('apply-caddy-plan'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      timeout: workerTimeout,
      bundling,
      vpc,
      securityGroups: [securityGroup],
      allowPublicSubnet: true,
    });

    const persistCaddy = new NodejsFunction(this, `${id}/persist_caddy/function`, {
      entry: handlerEntry('persist-caddy-config'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      timeout: workerTimeout,
      environment: {
        CADDY_CONFIG_BUCKET: caddyConfigBucket,
        CADDY_CONFIG_KEY: caddyConfigKey,
      },
      bundling,
    });

    const caddyConfig = Bucket.fromBucketName(this, `${id}/caddy_config_bucket`, caddyConfigBucket);
    caddyConfig.grantReadWrite(persistCaddy, caddyConfigKey);

    const createRoute = this.routeWorkflow(`${id}/create_route`, applyCaddy, persistCaddy);
    const deleteRoute = this.routeWorkflow(`${id}/delete_route`, applyCaddy, persistCaddy);

    const prepareRoute = new NodejsFunction(this, `${id}/prepare_route/function`, {
      entry: handlerEntry('prepare-route'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      timeout: workerTimeout,
      environment: {
        CLUSTER_NAME: clusterName,
        CREATE_ROUTE_STATE_MACHINE_ARN: createRoute.stateMachineArn,
        DELETE_ROUTE_STATE_MACHINE_ARN: deleteRoute.stateMachineArn,
      },
      bundling,
    });

    prepareRoute.addToRolePolicy(new PolicyStatement({
      actions: [
        'servicediscovery:DiscoverInstances',
        'servicediscovery:GetNamespace',
        'servicediscovery:ListServices',
      ],
      resources: ['*'],
    }));

    createRoute.grantStartExecution(prepareRoute);
    deleteRoute.grantStartExecution(prepareRoute);

    this.serviceToken = prepareRoute.functionArn;
  }

  private routeWorkflow(
    workflowId: string,
    applyFn: NodejsFunction,
    persistFn: NodejsFunction,
  ): StateMachine {
    const apply = new LambdaInvoke(this, `${workflowId}/apply`, {
      lambdaFunction: applyFn,
      payloadResponseOnly: true,
      resultPath: '$.caddy',
    });
    const persist = new LambdaInvoke(this, `${workflowId}/persist`, {
      lambdaFunction: persistFn,
      payloadResponseOnly: true,
    });
    const persistFailed = new LambdaInvoke(this, `${workflowId}/persist_failed`, {
      lambdaFunction: persistFn,
      payloadResponseOnly: true,
    });

    apply.addCatch(persistFailed, { resultPath: '$.error' });
    persist.addCatch(persistFailed, { resultPath: '$.error' });

    return new StateMachine(this, workflowId, {
      definitionBody: DefinitionBody.fromChainable(apply.next(persist)),
      timeout: Duration.minutes(2),
    });
  }

}
