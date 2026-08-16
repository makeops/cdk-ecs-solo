# `@makeops/cdk-ecs-solo`

Deploy an app onto a single EC2 instance with the help of ECS.

## Why?

Not all projects require a full, best-practice deployment behind a load balancer. This stack instead:

- Launches a single instance that joins an ECS cluster
- Deploys your container on the instance
- Sets up [Caddy](https://caddyserver.com/) for HTTPS reverse proxy

## Support

Questions or need help with this construct? Contact [MakeOps Team](https://www.makeops.com/contact).

## Why

- **ECS for lifecycle** - deploy, restart, and run containers the ECS way
- **EC2 for cost** - skip the typical ALB + Fargate stack when one box is enough
- **Caddy for SSL** - point a domain at your instance and HTTPS is handled for you

## Install

```bash
npm install @makeops/cdk-ecs-solo
```

Peer dependencies: `aws-cdk-lib` and `constructs`.

## Quick start

Create a cluster (and optional control plane) in your CDK stack:

```ts
import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { SoloEC2Cluster, SoloClusterControlPlane } from '@makeops/cdk-ecs-solo';

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    new SoloEC2Cluster(this, 'solo_cluster', {
      clusterName: 'solo-cluster-v1',
    });

    new SoloClusterControlPlane(this, 'control_plane', {
      clusterName: 'solo-cluster-v1',
    });
  }
}
```

Give the stack a concrete account and region - the construct looks up the default VPC:

```ts
new MyStack(app, 'MyStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
```

Then deploy as usual with the CDK CLI (`cdk deploy`).

## SSL with Caddy

The cluster runs Caddy on ports 80 and 443. Point your domain’s DNS at the instance’s public IP and Caddy will obtain and renew certificates automatically.
