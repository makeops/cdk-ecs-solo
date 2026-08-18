import { request } from 'node:http';
import type { CaddyRoute, ExposeServiceProperties } from './types.mts';

const CADDY_ADMIN_PORT = 2019;

export async function caddyHttp(ip: string, method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
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

export async function caddyRequest(ip: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const { status, text } = await caddyHttp(ip, method, path, body);
  if (status < 200 || status >= 300) {
    throw new Error(`Caddy ${method} ${path} failed (${status}): ${text}`);
  }

  return text ? JSON.parse(text) : undefined;
}

export function additionalDomainsOf(props: ExposeServiceProperties): string[] {
  const value = props.additionalDomains;
  if (value === undefined || value === '') {
    return [];
  }
  if (typeof value === 'string') {
    return value.split(',').map((name) => name.trim()).filter(Boolean);
  }
  return value.map((name) => name.trim()).filter(Boolean);
}

export function canonicalRouteId(serviceName: string): string {
  return `${serviceName}--canonical`;
}

export function reverseProxyRoute(serviceName: string, namespaceName: string, port: string | number, domain: string): CaddyRoute {
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

export function canonicalRedirectRoute(serviceName: string, domain: string, additionalDomains: string[]): CaddyRoute {
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

export async function upsertCaddyRoute(ip: string, route: CaddyRoute): Promise<void> {
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

export async function deleteCaddyRoute(ip: string, routeId: string): Promise<void> {
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

export async function ensureHttpsListen(ip: string): Promise<void> {
  const listen = await caddyRequest(ip, 'GET', '/config/apps/http/servers/srv0/listen');
  const current = Array.isArray(listen) ? listen.map(String) : [];
  if (current.some((address) => address === '0.0.0.0:443' || address === ':443')) {
    return;
  }

  await caddyRequest(ip, 'POST', '/config/apps/http/servers/srv0/listen', '0.0.0.0:443');
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

export function isUnreachable(error: unknown): boolean {
  const code = networkErrorCode(error);
  return code !== undefined && ['ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET'].includes(code);
}
