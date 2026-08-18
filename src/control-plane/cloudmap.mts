import {
  DiscoverInstancesCommand,
  FilterCondition,
  GetNamespaceCommand,
  ListServicesCommand,
  ServiceDiscoveryClient,
} from '@aws-sdk/client-servicediscovery';
import { requiredEnv } from './env.mts';

const CADDY_ADMIN_PORT = 2019;

const serviceDiscovery = new ServiceDiscoveryClient({});

function namespaceIdFromArn(arn: string): string {
  const id = arn.split('/').pop();
  if (!id) {
    throw new Error(`Invalid namespace ARN: ${arn}`);
  }
  return id;
}

async function getNamespaceName(namespaceArn: string): Promise<{ id: string; name: string }> {
  const id = namespaceIdFromArn(namespaceArn);
  const response = await serviceDiscovery.send(new GetNamespaceCommand({ Id: id }));
  const name = response.Namespace?.Name;
  if (!name) {
    throw new Error(`Cloud Map namespace ${id} has no name`);
  }
  return { id, name };
}

async function findIngressServiceName(namespaceId: string, clusterName: string): Promise<string> {
  const suffix = `.${clusterName}-ingress`;
  const matches: string[] = [];
  let nextToken: string | undefined;

  do {
    const page = await serviceDiscovery.send(new ListServicesCommand({
      Filters: [{
        Name: 'NAMESPACE_ID',
        Values: [namespaceId],
        Condition: FilterCondition.EQ,
      }],
      NextToken: nextToken,
    }));

    for (const service of page.Services ?? []) {
      const name = service.Name ?? '';
      if (name.startsWith('aws-ecs-sc.client.') && name.endsWith(suffix)) {
        matches.push(name);
      }
    }

    nextToken = page.NextToken;
  } while (nextToken);

  if (matches.length === 0) {
    throw new Error(`No Service Connect ingress Cloud Map service matching *${suffix} in namespace ${namespaceId}`);
  }
  if (matches.length > 1) {
    throw new Error(`Expected one ingress Cloud Map service, found: ${matches.join(', ')}`);
  }

  return matches[0];
}

async function findIngressIpv4(namespaceName: string, serviceName: string): Promise<string> {
  const discovered = await serviceDiscovery.send(new DiscoverInstancesCommand({
    NamespaceName: namespaceName,
    ServiceName: serviceName,
    HealthStatus: 'ALL',
  }));

  const instances = discovered.Instances ?? [];
  if (instances.length === 0) {
    throw new Error(`No instances registered for Cloud Map service ${serviceName}`);
  }
  if (instances.length > 1) {
    throw new Error(`Expected one ingress instance, found ${instances.length}`);
  }

  const ipv4 = instances[0].Attributes?.AWS_INSTANCE_IPV4;
  if (!ipv4) {
    throw new Error(`Ingress instance for ${serviceName} has no AWS_INSTANCE_IPV4`);
  }

  return ipv4;
}

export async function resolveIngress(namespaceArn: string) {
  const clusterName = requiredEnv('CLUSTER_NAME');
  const namespace = await getNamespaceName(namespaceArn);
  const ingressServiceName = await findIngressServiceName(namespace.id, clusterName);
  const ingressIp = await findIngressIpv4(namespace.name, ingressServiceName);

  console.log(`Ingress Caddy admin at ${ingressIp}:${CADDY_ADMIN_PORT} via ${ingressServiceName}`);

  return { namespace, ingressIp };
}
