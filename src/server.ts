import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

type RequestWithNodeRuntime = Request & {
  runtime?: {
    name?: string;
    node?: {
      req?: {
        socket?: {
          remoteAddress?: unknown;
        };
      };
    };
  };
};

type ContextWithNodeSocket = {
  node?: {
    req?: {
      socket?: {
        remoteAddress?: unknown;
      };
    };
  };
  req?: {
    socket?: {
      remoteAddress?: unknown;
    };
  };
  socket?: {
    remoteAddress?: unknown;
  };
};

export function extractTrustedPeerRemoteAddress(
  request: Request,
  ctx?: unknown,
): string | undefined {
  const reqRuntime = (request as RequestWithNodeRuntime).runtime;
  const ctxObj = ctx && typeof ctx === "object" ? (ctx as ContextWithNodeSocket) : undefined;
  const candidate =
    reqRuntime?.node?.req?.socket?.remoteAddress ??
    ctxObj?.node?.req?.socket?.remoteAddress ??
    ctxObj?.req?.socket?.remoteAddress ??
    ctxObj?.socket?.remoteAddress;

  if (typeof candidate !== "string") {
    return undefined;
  }
  const trimmed = candidate.trim();
  return trimmed !== "" ? trimmed : undefined;
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/uploads/")) {
        const { serveUploadFile } = await import("./server/uploads-handler.ts");
        const uploadRes = await serveUploadFile(request);
        if (uploadRes) return uploadRes;
      }

      if (url.pathname.startsWith("/api")) {
        const { isRemotePhpApiEnabled, proxyHostingerApiRequest } =
          await import("./server/hostinger-proxy.ts");
        const envRecord =
          env && typeof env === "object" ? (env as Record<string, string | undefined>) : undefined;
        const useRemote = isRemotePhpApiEnabled(envRecord);
        if (useRemote) {
          return await proxyHostingerApiRequest(request);
        }
        const { handleApiRequest } = await import("./server/api-handler.ts");
        const remoteAddress = extractTrustedPeerRemoteAddress(request, ctx);
        const apiResponse = await handleApiRequest(
          request,
          envRecord,
          remoteAddress ? { remoteAddress } : undefined,
        );
        if (apiResponse) return apiResponse;
      }

      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
