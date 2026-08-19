export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  error?: string;
  [key: string]: unknown;
  data?: T;
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(path, {
    credentials: "include",
    ...init,
    headers,
  });
}

export async function apiJson<T = Record<string, unknown>>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await request(path, init);
  let data: ApiResponse & T;
  try {
    data = await res.json();
  } catch {
    throw new ApiError(res.status, res.statusText || "Invalid JSON response");
  }
  if (!res.ok || data.success === false) {
    throw new ApiError(res.status, data.error || res.statusText || "Request failed");
  }
  return data as T;
}

export interface ClashConnection {
  port: string;
  secret: string;
  unix: string;
}

const CLASH_KEY = "zkeen-clash";

export function loadClashConnection(): ClashConnection {
  const fallback: ClashConnection = { port: "9090", secret: "", unix: "" };
  try {
    const raw = localStorage.getItem(CLASH_KEY);
    if (!raw) return fallback;
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return fallback;
  }
}

export function saveClashConnection(conn: ClashConnection) {
  localStorage.setItem(CLASH_KEY, JSON.stringify(conn));
}

export function parseClashFromYaml(yaml: string): Partial<ClashConnection> {
  const result: Partial<ClashConnection> = {};
  const ec = yaml.match(/^external-controller:\s*['"]?([^'"\n#]+)/m)?.[1]?.trim();
  if (ec) {
    if (ec.startsWith("/")) {
      const parts = ec.split("/");
      result.unix = parts[parts.length - 1] || "";
    } else if (ec.includes(":")) {
      result.port = ec.split(":").pop() || "9090";
    } else {
      result.port = ec;
    }
  }
  const secret = yaml.match(/^secret:\s*['"]?([^'"\n#]+)/m)?.[1]?.trim();
  if (secret && secret !== '""' && secret !== "''") {
    result.secret = secret.replace(/^['"]|['"]$/g, "");
  }
  return result;
}

export function clashHeaders(conn: ClashConnection): HeadersInit {
  const headers: Record<string, string> = {};
  if (conn.unix) {
    headers["x-clash-unix"] = conn.unix;
  } else if (conn.port) {
    headers["x-clash-port"] = conn.port;
  }
  if (conn.secret) {
    headers["x-clash-secret"] = conn.secret;
  }
  return headers;
}

export async function clashJson<T>(
  path: string,
  conn: ClashConnection,
  init?: RequestInit,
): Promise<T> {
  const clean = path.replace(/^\//, "");
  const res = await request(`/clash/${clean}`, {
    ...init,
    headers: {
      ...clashHeaders(conn),
      ...(init?.headers || {}),
    },
  });

  if (!res.ok) {
    let message = res.statusText;
    try {
      const err = await res.json();
      message = (err as ApiResponse).error || message;
    } catch {
      /* noop */
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) {
    return {} as T;
  }
  return res.json() as Promise<T>;
}
