import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  DiscoverInstancesCommand,
  FilterCondition,
  GetNamespaceCommand,
  ListServicesCommand,
  ServiceDiscoveryClient,
} from '@aws-sdk/client-servicediscovery';

const CADDY_ADMIN_PORT = 2019;

const serviceDiscovery = new ServiceDiscoveryClient({});
const s3 = new S3Client({});

interface ExposeServiceProperties {
  serviceName: string;
  namespaceArn: string;
  port: string | number;
}

interface CloudFormationEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  StackId: string;
  RequestId: string;
  LogicalResourceId: string;
  PhysicalResourceId?: string;
  ResourceType: string;
  ResourceProperties: ExposeServiceProperties;
  OldResourceProperties?: ExposeServiceProperties;
}

interface LambdaContext {
  logStreamName?: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function namespaceIdFromArn(arn: string): string {
  const id = arn.split('/').pop();
  if (!id) {
    throw new Error(`Invalid namespace ARN: ${arn}`);
  }
  return id;
}

function cfnSuccess(event: CloudFormationEvent, physicalResourceId: string, data: Record<string, string> = {}) {
  return {
    Status: 'SUCCESS',
    PhysicalResourceId: physicalResourceId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data,
  };
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

async function caddyRequest(ip: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`http://${ip}:${CADDY_ADMIN_PORT}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Caddy ${method} ${path} failed (${response.status}): ${text}`);
  }

  return text ? JSON.parse(text) : undefined;
}

function reverseProxyRoute(serviceName: string, namespaceName: string, port: string | number) {
  return {
    '@id': serviceName,
    handle: [{
      handler: 'reverse_proxy',
      upstreams: [{
        dial: `${serviceName}.${namespaceName}:${port}`,
      }],
    }],
  };
}

async function upsertCaddyRoute(ip: string, route: ReturnType<typeof reverseProxyRoute>): Promise<void> {
  const routeId = encodeURIComponent(String(route['@id']));
  const existing = await fetch(`http://${ip}:${CADDY_ADMIN_PORT}/id/${routeId}`);

  if (existing.ok) {
    await caddyRequest(ip, 'PATCH', `/id/${routeId}`, route);
    return;
  }

  if (existing.status !== 404) {
    throw new Error(`Caddy GET /id/${routeId} failed (${existing.status}): ${await existing.text()}`);
  }

  await caddyRequest(ip, 'PUT', '/config/apps/http/servers/srv0/routes/0', route);
}

async function deleteCaddyRoute(ip: string, routeId: string): Promise<void> {
  const encoded = encodeURIComponent(routeId);
  const response = await fetch(`http://${ip}:${CADDY_ADMIN_PORT}/id/${encoded}`, {
    method: 'DELETE',
  });

  if (response.ok || response.status === 404) {
    if (response.status === 404) {
      console.log(`Caddy route ${routeId} already absent`);
    }
    return;
  }

  throw new Error(`Caddy DELETE /id/${encoded} failed (${response.status}): ${await response.text()}`);
}

function networkErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.cause === undefined || error.cause === null || typeof error.cause !== 'object') {
    return undefined;
  }
  if (!('code' in error.cause) || typeof error.cause.code !== 'string') {
    return undefined;
  }
  return error.cause.code;
}

function isUnreachable(error: unknown): boolean {
  if (error instanceof TypeError) {
    return true;
  }

  const code = networkErrorCode(error);
  return code !== undefined && ['ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET'].includes(code);
}

async function resolveIngress(namespaceArn: string) {
  const clusterName = requiredEnv('CLUSTER_NAME');
  const namespace = await getNamespaceName(namespaceArn);
  const ingressServiceName = await findIngressServiceName(namespace.id, clusterName);
  const ingressIp = await findIngressIpv4(namespace.name, ingressServiceName);

  console.log(`Ingress Caddy admin at ${ingressIp}:${CADDY_ADMIN_PORT} via ${ingressServiceName}`);

  return { namespace, ingressIp };
}

async function persistCaddyConfig(ip: string): Promise<void> {
  const config = await caddyRequest(ip, 'GET', '/config/');
  await s3.send(new PutObjectCommand({
    Bucket: requiredEnv('CADDY_CONFIG_BUCKET'),
    Key: requiredEnv('CADDY_CONFIG_KEY'),
    Body: JSON.stringify(config),
    ContentType: 'application/json',
  }));
}

async function exposeService(event: CloudFormationEvent) {
  const { serviceName, namespaceArn, port } = event.ResourceProperties;

  if (!serviceName || !namespaceArn || port === undefined || port === '') {
    throw new Error('serviceName, namespaceArn, and port are required');
  }

  const { namespace, ingressIp } = await resolveIngress(namespaceArn);

  await upsertCaddyRoute(ingressIp, reverseProxyRoute(serviceName, namespace.name, port));

  const previousName = event.OldResourceProperties?.serviceName;
  if (event.RequestType === 'Update' && previousName && previousName !== serviceName) {
    await deleteCaddyRoute(ingressIp, previousName);
  }

  await persistCaddyConfig(ingressIp);

  return cfnSuccess(event, serviceName, {
    IngressIp: ingressIp,
    Upstream: `${serviceName}.${namespace.name}:${port}`,
  });
}

async function unexposeService(event: CloudFormationEvent, context?: LambdaContext) {
  const physicalResourceId = event.PhysicalResourceId
    || event.ResourceProperties?.serviceName
    || context?.logStreamName
    || 'deleted';
  const routeId = event.ResourceProperties?.serviceName || event.PhysicalResourceId;
  const namespaceArn = event.ResourceProperties?.namespaceArn;

  if (!routeId || !namespaceArn) {
    console.log('Delete missing route id or namespaceArn; skipping Caddy cleanup');
    return cfnSuccess(event, physicalResourceId);
  }

  let ingressIp: string;
  try {
    ({ ingressIp } = await resolveIngress(namespaceArn));
  } catch (error) {
    console.warn('Could not resolve ingress for Delete; treating resource as gone', error);
    return cfnSuccess(event, physicalResourceId);
  }

  try {
    await deleteCaddyRoute(ingressIp, routeId);
    await persistCaddyConfig(ingressIp);
  } catch (error) {
    if (isUnreachable(error)) {
      console.warn('Caddy unreachable on Delete; treating resource as gone', error);
      return cfnSuccess(event, physicalResourceId);
    }
    throw error;
  }

  return cfnSuccess(event, physicalResourceId);
}

export const handler = async (event: CloudFormationEvent, context?: LambdaContext) => {
  if (!(event && event.RequestType && event.StackId && event.ResourceType)) {
    console.log('[LambdaInvoke] Received event:', event);
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Handled normal Lambda invoke', event }),
    };
  }

  console.log('[CloudFormationCustomResource] Received event:', JSON.stringify(event));

  if (event.RequestType === 'Delete') {
    return unexposeService(event, context);
  }

  return exposeService(event);
};
