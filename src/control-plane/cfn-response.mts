import { request } from 'node:https';
import type { CfnResponseBody } from './types.mts';

export function shouldSkipCfnResponse(responseUrl: string | undefined): boolean {
  if (!responseUrl) {
    return true;
  }

  try {
    const host = new URL(responseUrl).hostname;
    return host === 'example.invalid' || host.endsWith('.invalid');
  } catch {
    return true;
  }
}

export async function sendCfnResponse(responseUrl: string | undefined, body: CfnResponseBody): Promise<CfnResponseBody> {
  if (shouldSkipCfnResponse(responseUrl)) {
    console.log('Skipping CloudFormation response (missing or dummy ResponseURL)');
    return body;
  }

  const payload = JSON.stringify(body);
  const url = new URL(responseUrl!);

  await new Promise<void>((resolve, reject) => {
    const req = request({
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      method: 'PUT',
      headers: {
        'content-type': '',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      res.resume();
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
          return;
        }
        reject(new Error(`CloudFormation response PUT failed (${res.statusCode})`));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });

  return body;
}
