
export const handler = async (event: any, context?: any) => {
  if (event && event.RequestType && event.StackId && event.ResourceType) {
    // Looks like a CloudFormation Custom Resource event
    console.log("[CloudFormationCustomResource] Received event:", event);
    // Skeleton success response for CloudFormation Custom Resource
    return {
      Status: "SUCCESS",
      PhysicalResourceId: context?.logStreamName || "custom-resource-physical-id",
      StackId: event.StackId,
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
      Data: {
        Message: "Handled CloudFormation Custom Resource event",
      }
    };
  } else {
    // Assume this is a normal Lambda invoke
    console.log("[LambdaInvoke] Received event:", event);
    // Skeleton normal response
    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Handled normal Lambda invoke", event }),
    };
  }
};
