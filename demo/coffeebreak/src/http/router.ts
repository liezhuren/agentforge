import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  params: Record<string, string>;
  query: URLSearchParams;
}

export type RouteHandler = (ctx: RouteContext) => void | Promise<void>;

export interface RouteMatch {
  handler: RouteHandler;
  params: Record<string, string>;
}

interface CompiledRoute {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index] ?? '';
    const received = actual[index] ?? '';
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(received);
      continue;
    }
    if (expected !== received) return null;
  }
  return params;
}

/** 极简路由器：支持 /api/papers/:id/comments 这类路径参数。 */
export class Router {
  private readonly routes: CompiledRoute[] = [];

  register(method: string, pattern: string, handler: RouteHandler): this {
    this.routes.push({ method: method.toUpperCase(), segments: splitPath(pattern), handler });
    return this;
  }

  get(pattern: string, handler: RouteHandler): this {
    return this.register('GET', pattern, handler);
  }

  post(pattern: string, handler: RouteHandler): this {
    return this.register('POST', pattern, handler);
  }

  put(pattern: string, handler: RouteHandler): this {
    return this.register('PUT', pattern, handler);
  }

  delete(pattern: string, handler: RouteHandler): this {
    return this.register('DELETE', pattern, handler);
  }

  match(method: string, pathname: string): RouteMatch | null {
    const target = method.toUpperCase();
    const actual = splitPath(pathname);
    for (const route of this.routes) {
      if (route.method !== target) continue;
      const params = matchSegments(route.segments, actual);
      if (params !== null) {
        return { handler: route.handler, params };
      }
    }
    return null;
  }
}
