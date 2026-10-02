export const handler = async (event, context) => {
  console.log(`Lambda version: ${context.functionVersion}`);
  console.log(`Request id: ${context.awsRequestId}`);
  return { version: context.functionVersion };
};
