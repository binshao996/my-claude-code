export type ParsedCommandInput = {
  name: string;
  args: string;
};

export function parseCommandInput(input: string): ParsedCommandInput | null {
  const trimmed = input.trim();

  if (!trimmed.startsWith("/")) {
    return null;
  }

  const body = trimmed.slice(1).trim();
  if (!body) return null;

  const firstSpace = body.search(/\s/);

  if (firstSpace === -1) {
    return { name: body, args: "" };
  }

  return {
    name: body.slice(0, firstSpace),
    args: body.slice(firstSpace).trim(),
  };
}
