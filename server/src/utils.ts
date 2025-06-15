export function injectVariables(text: string, variables: Record<string, string | number | boolean>) {
  return text.replace(/\{\s*([^{}\s]+)\s*}/g, (match, varName) => {
    if (Object.prototype.hasOwnProperty.call(variables, varName)) {
      return String(variables[varName]);
    }
    return match;
  });
}
