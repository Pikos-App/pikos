import type { APIRoute } from "astro";
import { getPool, ensureTable } from "../../lib/db";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let email: string;
  let honeypot: string | undefined;

  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body = await request.json();
    email = body?.email;
    honeypot = body?.website;
  } else {
    const form = await request.formData();
    email = form.get("email") as string;
    honeypot = form.get("website") as string;
  }

  if (honeypot) {
    // Silently accept so bots don't know they were rejected
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return new Response(JSON.stringify({ error: "Invalid email" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  await ensureTable();

  const result = await getPool().query(
    `INSERT INTO waitlist (email) VALUES ($1) ON CONFLICT (email) DO NOTHING RETURNING id`,
    [email],
  );

  const duplicate = result.rowCount === 0;

  return new Response(JSON.stringify({ ok: true, duplicate }), {
    status: duplicate ? 200 : 201,
    headers: { "Content-Type": "application/json" },
  });
};
