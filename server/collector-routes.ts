import crypto from "node:crypto";
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { CollectorControlStore } from "./collector-control.ts";
import { verifyIncomingBatch } from "./collector-upload-verifier.ts";

function timingSafeBearer(suppliedHeader: string | undefined, expectedToken: string): boolean {
  const supplied = suppliedHeader?.startsWith("Bearer ") ? suppliedHeader.slice(7) : "";
  const expected = Buffer.from(expectedToken);
  const actual = Buffer.from(supplied);
  return expected.length >= 32 && expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function agentAuth(expectedToken: string): RequestHandler {
  return (request, response, next) => {
    if (!timingSafeBearer(request.headers.authorization, expectedToken)) {
      response.status(401).json({ error: { code: "COLLECTOR_AGENT_UNAUTHORIZED", message: "采集Agent认证失败" } });
      return;
    }
    next();
  };
}

function bodyAgentId(request: Request): string {
  return String(request.body?.agentId || "").trim();
}

function leaseToken(request: Request): string {
  return String(request.headers["x-collector-lease"] || request.body?.leaseToken || "").trim();
}

export function createCollectorAgentRouter(store: CollectorControlStore, token: string, incoming: { localRoot: string; remoteRoot: string }): Router {
  const router = Router();
  router.use(agentAuth(token));

  router.post("/heartbeat", (request, response, next) => {
    try {
      response.json(store.heartbeatAgent(request.body || {}));
    } catch (error) {
      next(error);
    }
  });

  router.post("/verification/claim", (request, response, next) => {
    try { response.json({ request: store.claimVerification(bodyAgentId(request), String(request.body?.verificationId || "")) }); }
    catch (error) { next(error); }
  });
  router.post("/verification/complete", (request, response, next) => {
    try {
      store.completeVerification(bodyAgentId(request), String(request.body?.requestId || ""), String(request.body?.verificationId || ""), request.body?.verified === true);
      response.sendStatus(204);
    } catch (error) { next(error); }
  });

  router.post("/filter-catalog/claim", (request, response, next) => {
    try {
      response.json({ request: store.claimCatalogSync(bodyAgentId(request)) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/filter-catalog/complete", (request, response, next) => {
    try {
      response.json(store.completeCatalogSync(String(request.body?.requestId || ""), bodyAgentId(request), request.body?.catalog));
    } catch (error) {
      next(error);
    }
  });

  router.post("/filter-catalog/fail", (request, response, next) => {
    try {
      store.failCatalogSync(String(request.body?.requestId || ""), bodyAgentId(request), String(request.body?.message || "Filter目录同步失败"));
      response.sendStatus(204);
    } catch (error) {
      next(error);
    }
  });

  router.post("/jobs/claim", (request, response, next) => {
    try {
      response.json(store.claimJob(bodyAgentId(request)));
    } catch (error) {
      next(error);
    }
  });

  router.post("/jobs/:id/runs", (request, response, next) => {
    try {
      store.registerRun(String(request.params.id), bodyAgentId(request), leaseToken(request), request.body?.runId, request.body?.searchId, request.body?.uploadToken);
      response.sendStatus(204);
    } catch (error) { next(error); }
  });

  router.post("/jobs/:id/heartbeat", (request, response, next) => {
    try {
      response.json(store.heartbeatJob(request.params.id, bodyAgentId(request), leaseToken(request), request.body?.evidence || {}));
    } catch (error) {
      next(error);
    }
  });

  router.post("/jobs/:id/state", (request, response, next) => {
    try { response.json(store.agentJobState(String(request.params.id), bodyAgentId(request))); }
    catch (error) { next(error); }
  });

  router.post("/jobs/:id/checkpoints", async (request, response, next) => {
    try {
      await verifyIncomingBatch(request.body || {}, incoming.localRoot, incoming.remoteRoot, String(request.params.id));
      response.status(201).json(store.checkpointPage(request.params.id, bodyAgentId(request), leaseToken(request), request.body || {}));
    } catch (error) {
      next(error);
    }
  });

  router.post("/jobs/:id/local-pages", (request, response, next) => {
    try { response.json(store.reportLocalPages(String(request.params.id), bodyAgentId(request), leaseToken(request), request.body || {})); }
    catch (error) { next(error); }
  });
  router.post("/jobs/:id/collection-complete", (request, response, next) => {
    try { response.json(store.finishCollection(String(request.params.id), bodyAgentId(request), leaseToken(request), request.body || {})); }
    catch (error) { next(error); }
  });
  router.post("/jobs/:id/uploads", async (request, response, next) => {
    try {
      const id = String(request.params.id);
      store.authorizeUpload(id, bodyAgentId(request), String(request.body?.runId || ""), String(request.body?.uploadToken || ""));
      await verifyIncomingBatch(request.body || {}, incoming.localRoot, incoming.remoteRoot, id);
      response.json(store.checkpointUpload(id, bodyAgentId(request), request.body || {}));
    } catch (error) { next(error); }
  });
  router.post("/jobs/:id/delivery-error", (request, response, next) => {
    try { store.reportDeliveryError(String(request.params.id), bodyAgentId(request), request.body || {}); response.sendStatus(204); }
    catch (error) { next(error); }
  });

  router.post("/jobs/:id/complete", (request, response, next) => {
    try {
      response.json(store.completeJob(request.params.id, bodyAgentId(request), leaseToken(request)));
    } catch (error) {
      next(error);
    }
  });

  router.post("/jobs/:id/pause-ack", (request, response, next) => {
    try {
      response.json(store.acknowledgePause(request.params.id, bodyAgentId(request), leaseToken(request)));
    } catch (error) {
      next(error);
    }
  });

  router.post("/jobs/:id/safety-stop", (request, response, next) => {
    try {
      response.json(store.safetyStop(request.params.id, bodyAgentId(request), leaseToken(request), request.body || {}));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export function createCollectorControlRouter(
  store: CollectorControlStore,
  requireBrowserMutation: RequestHandler,
  record: (request: Request, action: string, detail?: string) => void,
): Router {
  const router = Router();

  router.get("/filter-catalog", (_request, response) => response.json(store.getCatalog()));
  router.post("/verification", requireBrowserMutation, (request, response, next) => {
    try {
      const result = store.requestVerification(String(request.body?.agentId || ""), String(request.body?.verificationId || ""));
      record(request, "COLLECTOR_USER_VERIFIED", String(result.id));
      response.status(202).json(result);
    } catch (error) { next(error); }
  });
  router.post("/filter-catalog/sync", requireBrowserMutation, (request, response, next) => {
    try {
      const result = store.requestCatalogSync();
      record(request, "COLLECTOR_FILTER_SYNC_REQUEST", String(result.id));
      response.status(202).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/control/acknowledge-safety", requireBrowserMutation, (request, response, next) => {
    try {
      const result = store.acknowledgeGlobalPause(request.body?.reason);
      record(request, "COLLECTOR_GLOBAL_PAUSE_ACKNOWLEDGED", String(request.body?.reason || "").slice(0, 500));
      response.json(result);
    } catch (error) { next(error); }
  });

  router.get("/search-templates", (_request, response) => response.json({ items: store.listTemplates() }));
  router.post("/search-templates", requireBrowserMutation, (request, response, next) => {
    try {
      const result = store.createTemplate(request.body || {});
      record(request, "COLLECTOR_TEMPLATE_CREATE", result.id);
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });
  router.patch("/search-templates/:id", requireBrowserMutation, (request, response, next) => {
    try {
      const result = store.updateTemplate(String(request.params.id), request.body || {});
      record(request, "COLLECTOR_TEMPLATE_UPDATE", result.id);
      response.json(result);
    } catch (error) {
      next(error);
    }
  });
  router.delete("/search-templates/:id", requireBrowserMutation, (request, response, next) => {
    try {
      store.deleteTemplate(String(request.params.id));
      record(request, "COLLECTOR_TEMPLATE_DELETE", String(request.params.id));
      response.sendStatus(204);
    } catch (error) {
      next(error);
    }
  });
  router.post("/search-templates/:id/copy", requireBrowserMutation, (request, response, next) => {
    try {
      const result = store.duplicateTemplate(String(request.params.id), request.body?.name ? String(request.body.name) : undefined);
      record(request, "COLLECTOR_TEMPLATE_COPY", `${request.params.id}:${result.id}`);
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/jobs", (request, response) => {
    const limit = Math.max(1, Math.min(500, Number(request.query.limit || 200)));
    response.json({ items: store.listJobs(limit), control: store.getControlState(), agents: store.listAgents() });
  });
  router.get("/jobs/:id", (request, response) => {
    const job = store.getJob(String(request.params.id));
    if (!job) {
      response.status(404).json({ error: { code: "COLLECTION_JOB_NOT_FOUND", message: "采集任务不存在" } });
      return;
    }
    response.json(job);
  });
  router.post("/jobs", requireBrowserMutation, (request, response, next) => {
    try {
      const result = store.createJob(request.body || {});
      record(request, "COLLECTOR_JOB_CREATE", result.id);
      response.status(202).json(result);
    } catch (error) {
      next(error);
    }
  });
  router.patch("/jobs/:id/limits", requireBrowserMutation, (request, response, next) => {
    try {
      const id = String(request.params.id);
      const result = store.updatePausedJobLimits(id, request.body || {});
      record(request, "COLLECTOR_JOB_LIMITS_UPDATE", id);
      response.json(result);
    } catch (error) {
      next(error);
    }
  });
  for (const action of ["pause", "resume", "cancel", "move-up", "move-down"] as const) {
    router.post(`/jobs/:id/${action}`, requireBrowserMutation, (request, response, next) => {
      try {
        const id = String(request.params.id);
        const result = action === "pause"
          ? store.pauseJob(id)
          : action === "resume"
            ? store.resumeJob(id)
            : action === "cancel"
              ? store.cancelJob(id)
              : store.moveJob(id, action === "move-up" ? "up" : "down");
        record(request, `COLLECTOR_JOB_${action.replace("-", "_").toUpperCase()}`, id);
        response.json(result);
      } catch (error) {
        next(error);
      }
    });
  }

  router.get("/schedules", (_request, response) => response.json({ items: store.listSchedules() }));
  router.post("/schedules", requireBrowserMutation, (request, response, next) => {
    try {
      const result = store.createSchedule(request.body || {});
      record(request, "COLLECTOR_SCHEDULE_CREATE", result.id);
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });
  router.patch("/schedules/:id", requireBrowserMutation, (request, response, next) => {
    try {
      const result = store.updateSchedule(String(request.params.id), request.body || {});
      record(request, "COLLECTOR_SCHEDULE_UPDATE", result.id);
      response.json(result);
    } catch (error) {
      next(error);
    }
  });
  router.delete("/schedules/:id", requireBrowserMutation, (request, response, next) => {
    try {
      store.deleteSchedule(String(request.params.id));
      record(request, "COLLECTOR_SCHEDULE_DELETE", String(request.params.id));
      response.sendStatus(204);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export function collectorRouteError(
  error: unknown,
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (error instanceof Error && "code" in error && "status" in error) {
    const controlled = error as Error & { code: string; status: number };
    response.status(controlled.status).json({ error: { code: controlled.code, message: controlled.message } });
    return;
  }
  next(error);
}
