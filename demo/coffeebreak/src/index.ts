import { startServer } from './server.ts';

export { createApp, createRequestHandler, createRouter, handleRequest } from './app.ts';
export { createServer, PORT, startServer, stopServer } from './server.ts';
export { store, resetStore, PAPER_FIELD_NAMES, SEED_ADMIN_USERNAME, SEED_ADMIN_PASSWORD } from './store/store.ts';
export { Router } from './http/router.ts';
export { HttpError, badRequest, unauthorized, forbidden, notFound, conflict, internalError, toErrorResponse } from './http/errors.ts';
export { sendJson, sendNoContent } from './http/respond.ts';
export { readJsonBody, readRawBody } from './http/body.ts';

// 当本文件是进程入口时（进程由 src/index.ts 启动），确保服务已在监听。
// src/server.ts 在被直接执行时会自行监听；这里作为稳定的启动兜底。
const entryPath = (process.argv[1] ?? '').replace(/\\/g, '/');
const startedFromThisModule = /(^|\/)src\/index\.[cm]?[jt]s$/.test(entryPath) || /(^|\/)index\.[cm]?[jt]s$/.test(entryPath);

if (startedFromThisModule) {
  startServer();
}
