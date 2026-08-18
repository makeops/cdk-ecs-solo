export interface ExposeServiceProperties {
  serviceName: string;
  namespaceArn: string;
  port: string | number;
  domain: string;
  additionalDomains?: string | string[];
}

export interface CloudFormationEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  ResponseURL?: string;
  StackId: string;
  RequestId: string;
  LogicalResourceId: string;
  PhysicalResourceId?: string;
  ResourceType: string;
  ResourceProperties: ExposeServiceProperties;
  OldResourceProperties?: ExposeServiceProperties;
  ServiceToken?: string;
}

export interface LambdaContext {
  logStreamName?: string;
}

export interface CaddyRoute {
  '@id': string;
  [key: string]: unknown;
}

export interface CaddyPlan {
  physicalResourceId: string;
  ingressIp?: string;
  ensureHttpsListen: boolean;
  upsert: CaddyRoute[];
  delete: string[];
  onUnreachable: 'throw' | 'success';
  data?: Record<string, string>;
}

export interface CaddyApplyResult {
  config?: unknown;
  skipped?: boolean;
  reason?: string;
}

export interface StepFunctionError {
  Error?: string;
  Cause?: string;
}

export interface WorkflowInput {
  cfn: CloudFormationEvent;
  plan?: CaddyPlan;
  caddy?: CaddyApplyResult;
  error?: StepFunctionError;
}

export interface CfnResponseBody {
  Status: 'SUCCESS' | 'FAILED';
  PhysicalResourceId: string;
  StackId: string;
  RequestId: string;
  LogicalResourceId: string;
  Reason?: string;
  Data?: Record<string, string>;
}
