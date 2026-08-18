import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { additionalDomainsOf, canonicalRedirectRoute, canonicalRouteId, reverseProxyRoute } from './caddy.mts';
import { sendCfnResponse } from './cfn-response.mts';
import { resolveIngress } from './cloudmap.mts';
import { requiredEnv } from './env.mts';
import type { CaddyPlan, CaddyRoute, CloudFormationEvent, LambdaContext } from './types.mts';

const sfn = new SFNClient({});

function isCloudFormationEvent(event: unknown): event is CloudFormationEvent {
  if (event === null || typeof event !== 'object') {
    return false;
  }
  const candidate = event as Partial<CloudFormationEvent>;
  return Boolean(candidate.RequestType && candidate.StackId && candidate.ResourceType);
}

async function prepareCreate(event: CloudFormationEvent): Promise<CaddyPlan> {
  const { serviceName, namespaceArn, port, domain } = event.ResourceProperties;
  const additionalDomains = additionalDomainsOf(event.ResourceProperties);

  if (!serviceName || !namespaceArn || port === undefined || port === '' || !domain) {
    throw new Error('serviceName, namespaceArn, port, and domain are required');
  }

  const { namespace, ingressIp } = await resolveIngress(namespaceArn);

  console.log(`Exposing ${serviceName} at https://${domain}` + (additionalDomains.length > 0 ? ` (redirects from ${additionalDomains.join(', ')})` : ''));

  const upsert: CaddyRoute[] = [reverseProxyRoute(serviceName, namespace.name, port, domain)];
  const remove: string[] = [];

  if (additionalDomains.length > 0) {
    upsert.push(canonicalRedirectRoute(serviceName, domain, additionalDomains));
  } else {
    remove.push(canonicalRouteId(serviceName));
  }

  const previousName = event.OldResourceProperties?.serviceName;
  if (event.RequestType === 'Update' && previousName && previousName !== serviceName) {
    remove.push(previousName, canonicalRouteId(previousName));
  }

  return {
    physicalResourceId: serviceName,
    ingressIp,
    ensureHttpsListen: true,
    upsert,
    delete: remove,
    onUnreachable: 'throw',
    data: {
      IngressIp: ingressIp,
      Upstream: `${serviceName}.${namespace.name}:${port}`,
      Domain: domain,
    },
  };
}

async function prepareDelete(event: CloudFormationEvent, context?: LambdaContext): Promise<CaddyPlan> {
  const physicalResourceId = event.PhysicalResourceId
    || event.ResourceProperties?.serviceName
    || context?.logStreamName
    || 'deleted';
  const routeId = event.ResourceProperties?.serviceName || event.PhysicalResourceId;
  const namespaceArn = event.ResourceProperties?.namespaceArn;

  if (!routeId || !namespaceArn) {
    console.log('Delete missing route id or namespaceArn; skipping Caddy cleanup');
    return {
      physicalResourceId,
      ensureHttpsListen: false,
      upsert: [],
      delete: [],
      onUnreachable: 'success',
    };
  }

  try {
    const { ingressIp } = await resolveIngress(namespaceArn);
    return {
      physicalResourceId,
      ingressIp,
      ensureHttpsListen: false,
      upsert: [],
      delete: [routeId, canonicalRouteId(routeId)],
      onUnreachable: 'success',
    };
  } catch (error) {
    console.warn('Could not resolve ingress for Delete; treating resource as gone', error);
    return {
      physicalResourceId,
      ensureHttpsListen: false,
      upsert: [],
      delete: [],
      onUnreachable: 'success',
    };
  }
}

export async function prepareRoute(event: CloudFormationEvent, context?: LambdaContext): Promise<CaddyPlan> {
  if (event.RequestType === 'Delete') {
    return prepareDelete(event, context);
  }
  return prepareCreate(event);
}

export const handler = async (event: unknown, context?: LambdaContext) => {
  if (!isCloudFormationEvent(event)) {
    console.log('[LambdaInvoke] Received event');
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Handled normal Lambda invoke' }),
    };
  }

  console.log('[CloudFormationCustomResource]', event.RequestType, event.LogicalResourceId, event.RequestId);

  const stateMachineArn = event.RequestType === 'Delete'
    ? requiredEnv('DELETE_ROUTE_STATE_MACHINE_ARN')
    : requiredEnv('CREATE_ROUTE_STATE_MACHINE_ARN');

  try {
    const plan = await prepareRoute(event, context);
    const started = await sfn.send(new StartExecutionCommand({
      stateMachineArn,
      input: JSON.stringify({ cfn: event, plan }),
    }));

    return {
      ok: true,
      executionArn: started.executionArn,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await sendCfnResponse(event.ResponseURL, {
      Status: 'FAILED',
      PhysicalResourceId: event.PhysicalResourceId || event.ResourceProperties?.serviceName || 'unknown',
      StackId: event.StackId,
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
      Reason: reason,
    });
    return {
      ok: false,
      reason,
    };
  }
};
