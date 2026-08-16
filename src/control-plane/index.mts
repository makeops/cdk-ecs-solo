import { request } from 'node:http';
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
  domain: string;
  additionalDomains?: string | string[];
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

async function caddyHttp(ip: string, method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = request({
      host: ip,
      port: CADDY_ADMIN_PORT,
      path,
      method,
      headers: payload === undefined ? undefined : {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    req.setTimeout(5_000, () => {
      req.destroy(new Error(`Caddy ${method} ${path} timed out`));
    });
    req.on('error', reject);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

async function caddyRequest(ip: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const { status, text } = await caddyHttp(ip, method, path, body);
  if (status < 200 || status >= 300) {
    throw new Error(`Caddy ${method} ${path} failed (${status}): ${text}`);
  }

  return text ? JSON.parse(text) : undefined;
}

function additionalDomainsOf(props: ExposeServiceProperties): string[] {
  const value = props.additionalDomains;
  if (value === undefined || value === '') {
    return [];
  }
  if (typeof value === 'string') {
    return value.split(',').map((name) => name.trim()).filter(Boolean);
  }
  return value.map((name) => name.trim()).filter(Boolean);
}

function canonicalRouteId(serviceName: string): string {
  return `${serviceName}--canonical`;
}

function reverseProxyRoute(serviceName: string, namespaceName: string, port: string | number, domain: string) {
  return {
    '@id': serviceName,
    match: [{
      host: [domain],
    }],
    handle: [{
      handler: 'reverse_proxy',
      upstreams: [{
        dial: `${serviceName}.${namespaceName}:${port}`,
      }],
    }],
  };
}

function canonicalRedirectRoute(serviceName: string, domain: string, additionalDomains: string[]) {
  return {
    '@id': canonicalRouteId(serviceName),
    match: [{
      host: additionalDomains,
    }],
    handle: [{
      handler: 'static_response',
      status_code: 308,
      headers: {
        Location: [`https://${domain}{http.request.uri}`],
      },
    }],
  };
}

async function upsertCaddyRoute(ip: string, route: { '@id': string }): Promise<void> {
  const routeId = encodeURIComponent(String(route['@id']));
  const existing = await caddyHttp(ip, 'GET', `/id/${routeId}`);

  if (existing.status >= 200 && existing.status < 300) {
    await caddyRequest(ip, 'PATCH', `/id/${routeId}`, route);
    return;
  }

  if (existing.status !== 404) {
    throw new Error(`Caddy GET /id/${routeId} failed (${existing.status}): ${existing.text}`);
  }

  await caddyRequest(ip, 'PUT', '/config/apps/http/servers/srv0/routes/0', route);
}

async function deleteCaddyRoute(ip: string, routeId: string): Promise<void> {
  const encoded = encodeURIComponent(routeId);
  const { status, text } = await caddyHttp(ip, 'DELETE', `/id/${encoded}`);

  if (status >= 200 && status < 300) {
    return;
  }
  if (status === 404) {
    console.log(`Caddy route ${routeId} already absent`);
    return;
  }

  throw new Error(`Caddy DELETE /id/${encoded} failed (${status}): ${text}`);
}

function networkErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  if ('code' in error && typeof error.code === 'string') {
    return error.code;
  }
  if (error.cause === undefined || error.cause === null || typeof error.cause !== 'object') {
    return undefined;
  }
  if (!('code' in error.cause) || typeof error.cause.code !== 'string') {
    return undefined;
  }
  return error.cause.code;
}

function isUnreachable(error: unknown): boolean {
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

async function ensureHttpsListen(ip: string): Promise<void> {
  const listen = await caddyRequest(ip, 'GET', '/config/apps/http/servers/srv0/listen');
  const current = Array.isArray(listen) ? listen.map(String) : [];
  if (current.some((address) => address === '0.0.0.0:443' || address === ':443')) {
    return;
  }

  await caddyRequest(ip, 'POST', '/config/apps/http/servers/srv0/listen', '0.0.0.0:443');
}

async function exposeService(event: CloudFormationEvent) {
  const { serviceName, namespaceArn, port, domain } = event.ResourceProperties;
  const additionalDomains = additionalDomainsOf(event.ResourceProperties);

  if (!serviceName || !namespaceArn || port === undefined || port === '' || !domain) {
    throw new Error('serviceName, namespaceArn, port, and domain are required');
  }

  const { namespace, ingressIp } = await resolveIngress(namespaceArn);

  console.log(`Exposing ${serviceName} at https://${domain}` + (additionalDomains.length > 0 ? ` (redirects from ${additionalDomains.join(', ')})` : ''));

  await ensureHttpsListen(ingressIp);
  await upsertCaddyRoute(ingressIp, reverseProxyRoute(serviceName, namespace.name, port, domain));

  if (additionalDomains.length > 0) {
    await upsertCaddyRoute(ingressIp, canonicalRedirectRoute(serviceName, domain, additionalDomains));
  } else {
    await deleteCaddyRoute(ingressIp, canonicalRouteId(serviceName));
  }

  const previousName = event.OldResourceProperties?.serviceName;
  if (event.RequestType === 'Update' && previousName && previousName !== serviceName) {
    await deleteCaddyRoute(ingressIp, previousName);
    await deleteCaddyRoute(ingressIp, canonicalRouteId(previousName));
  }

  await persistCaddyConfig(ingressIp);

  return cfnSuccess(event, serviceName, {
    IngressIp: ingressIp,
    Upstream: `${serviceName}.${namespace.name}:${port}`,
    Domain: domain,
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
    await deleteCaddyRoute(ingressIp, canonicalRouteId(routeId));
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
