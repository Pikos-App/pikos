import type { APIRoute } from "astro";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

export const prerender = false;

const EMAILS_FILE = resolve("emails.json");

function loadEmails(): string[] {
  if (!existsSync(EMAILS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(EMAILS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveEmails(emails: string[]): void {
  writeFileSync(EMAILS_FILE, JSON.stringify(emails, null, 2));
}

export const POST: APIRoute = async ({ request }) => {
  let email: string;

  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body = await request.json();
    email = body?.email;
  } else {
    const form = await request.formData();
    email = form.get("email") as string;
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return new Response(JSON.stringify({ error: "Invalid email" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const emails = loadEmails();

  if (emails.includes(email)) {
    return new Response(JSON.stringify({ ok: true, duplicate: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  emails.push(email);
  saveEmails(emails);

  return new Response(JSON.stringify({ ok: true }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
};
