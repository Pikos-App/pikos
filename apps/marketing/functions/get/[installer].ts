import { downloadResponse } from "../../src/edge/download";

/** DOWNLOADS is unset until the Analytics Engine binding is added to the Pages project, and downloads still redirect without it. */
interface Env {
  DOWNLOADS?: { writeDataPoint(point: { blobs: string[]; indexes: string[] }): void };
}

export async function onRequest(context: {
  request: Request;
  env: Env;
  params: { installer: string };
}): Promise<Response> {
  return downloadResponse(context.request, context.params.installer, new Date(), (installer) =>
    context.env.DOWNLOADS?.writeDataPoint({ blobs: [installer], indexes: [installer] }),
  );
}
