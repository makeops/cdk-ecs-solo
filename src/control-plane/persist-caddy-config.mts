import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { sendCfnResponse } from './cfn-response.mts';
import { requiredEnv } from './env.mts';
import type { CfnResponseBody, StepFunctionError, WorkflowInput } from './types.mts';

const s3 = new S3Client({});

function formatError(error: StepFunctionError | undefined): string {
  if (!error) {
    return 'Route workflow failed';
  }
  const parts = [error.Error, error.Cause].filter(Boolean);
  return parts.join(': ').slice(0, 1000) || 'Route workflow failed';
}

export const handler = async (event: WorkflowInput): Promise<CfnResponseBody> => {
  const cfn = event.cfn;
  if (!cfn) {
    throw new Error('Missing CloudFormation event');
  }

  const failed = event.error !== undefined;
  if (!failed && event.caddy?.config !== undefined) {
    await s3.send(new PutObjectCommand({
      Bucket: requiredEnv('CADDY_CONFIG_BUCKET'),
      Key: requiredEnv('CADDY_CONFIG_KEY'),
      Body: JSON.stringify(event.caddy.config),
      ContentType: 'application/json',
    }));
  }

  const physicalResourceId = event.plan?.physicalResourceId
    || cfn.PhysicalResourceId
    || cfn.ResourceProperties?.serviceName
    || 'unknown';

  const body: CfnResponseBody = {
    Status: failed ? 'FAILED' : 'SUCCESS',
    PhysicalResourceId: physicalResourceId,
    StackId: cfn.StackId,
    RequestId: cfn.RequestId,
    LogicalResourceId: cfn.LogicalResourceId,
    Data: failed ? {} : (event.plan?.data ?? {}),
  };

  if (failed) {
    body.Reason = formatError(event.error);
  }

  return sendCfnResponse(cfn.ResponseURL, body);
};
