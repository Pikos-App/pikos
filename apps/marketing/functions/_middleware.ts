import { referrerToCount } from "../src/edge/referrer";

/** REFERRERS is unset until the Analytics Engine binding is added to the Pages project, and the site serves normally without it. */
interface Env {
  REFERRERS?: { writeDataPoint(point: { blobs: string[]; indexes: string[] }): void };
}

export async function onRequest(context: {
  request: Request;
  env: Env;
  next: () => Promise<Response>;
}): Promise<Response> {
  const response = await context.next();
  const referrer = referrerToCount(context.request, response, new Date());
  if (referrer) context.env.REFERRERS?.writeDataPoint({ blobs: [referrer], indexes: [referrer] });
  return response;
}
