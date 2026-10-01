export const handler = async (event, context) => {
  console.log(`Lambda version: ${context.functionVersion}`);
  return { version: context.functionVersion };
};
