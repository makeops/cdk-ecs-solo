import { caddyRequest, deleteCaddyRoute, ensureHttpsListen, isUnreachable, upsertCaddyRoute } from './caddy.mts';
import type { CaddyApplyResult, WorkflowInput } from './types.mts';

export const handler = async (event: WorkflowInput): Promise<CaddyApplyResult> => {
  const plan = event.plan;
  if (!plan) {
    throw new Error('Missing route plan');
  }

  if (!plan.ingressIp) {
    return { skipped: true, reason: 'no-ingress' };
  }

  const ip = plan.ingressIp;

  try {
    if (plan.ensureHttpsListen) {
      await ensureHttpsListen(ip);
    }

    for (const route of plan.upsert) {
      await upsertCaddyRoute(ip, route);
    }

    for (const routeId of plan.delete) {
      await deleteCaddyRoute(ip, routeId);
    }

    const config = await caddyRequest(ip, 'GET', '/config/');
    return { config };
  } catch (error) {
    if (plan.onUnreachable === 'success' && isUnreachable(error)) {
      console.warn('Caddy unreachable; treating resource as gone', error);
      return { skipped: true, reason: 'unreachable' };
    }
    throw error;
  }
};
