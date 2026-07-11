export class UnsafeLocalEndpointError extends Error {
  readonly code = "unsafe_local_endpoint";

  constructor() {
    super("unsafe_local_endpoint");
    this.name = "UnsafeLocalEndpointError";
  }
}

const LOOPBACK_BASE_URL = /^http:\/\/(127\.0\.0\.1|localhost):([0-9]{1,5})\/?$/u;

function validPortText(portText: string): boolean {
  if (portText.length > 1 && portText.startsWith("0")) return false;
  const port = Number(portText);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535;
}

export function normalizeLoopbackHttpBaseUrl(input: string): string {
  const value = input.trim();
  const match = LOOPBACK_BASE_URL.exec(value);
  if (!match || !validPortText(match[2])) throw new UnsafeLocalEndpointError();
  return `http://${match[1]}:${Number(match[2])}`;
}

export function validateLoopbackHostAndPort(
  host: string,
  port: number,
): { host: "127.0.0.1" | "localhost"; port: number; baseUrl: string } {
  if (
    (host !== "127.0.0.1" && host !== "localhost")
    || !Number.isSafeInteger(port)
    || port < 1
    || port > 65_535
  ) {
    throw new UnsafeLocalEndpointError();
  }
  return { host, port, baseUrl: `http://${host}:${port}` };
}
