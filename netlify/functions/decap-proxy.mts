import { createClient, SupabaseClient } from "@supabase/supabase-js";
import matter from "gray-matter";

const ALLOWED_TABLES = ["blog_posts", "works"];

let _supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (_supabase) return _supabase;

  const url = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.service_role;

  if (!url || !key) {
    const missing = [];
    if (!url) missing.push("SUPABASE_URL");
    if (!key) missing.push("SUPABASE_SERVICE_ROLE_KEY");
    throw new Error(`Missing env vars: ${missing.join(", ")}`);
  }

  _supabase = createClient(url, key);
  return _supabase;
}

function parsePathInfo(path: string): { table: string; slug: string } {
  const parts = path.split("/");
  const table = parts[0];
  const slug = parts[parts.length - 1].replace(/\.md$/, "");
  return { table, slug };
}

function rowToFileData(
  row: Record<string, unknown>,
  table: string
): { file: { path: string; label: string }; data: string } {
  const { id, content, created_at, ...fields } = row;
  const frontmatterData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    frontmatterData[key] = value;
  }
  return {
    file: {
      path: `${table}/${row.slug}.md`,
      label: String(row.title || row.slug),
    },
    data: matter.stringify(String(content || ""), frontmatterData),
  };
}

function frontmatterToRow(raw: string): Record<string, unknown> {
  const { data, content } = matter(raw);
  const row: Record<string, unknown> = { ...data, content: content.trim() };
  if ("body" in row) {
    row.content = row.body;
    delete row.body;
  }
  return row;
}

// ── Handlers ──────────────────────────────────────────────────────────

async function handleEntriesByFolder(params: {
  folder: string;
  extension: string;
}) {
  const { folder } = params;
  if (!ALLOWED_TABLES.includes(folder)) return [];

  const supabase = getSupabase();
  const { data, error } = await supabase.from(folder).select("*");
  if (error) throw error;

  return (data || []).map((row) => rowToFileData(row, folder));
}

async function handleGetEntry(params: { path: string }) {
  const { table, slug } = parsePathInfo(params.path);
  if (!ALLOWED_TABLES.includes(table)) {
    throw new Error(`Unknown collection: ${table}`);
  }

  const supabase = getSupabase();

  // Try exact slug first
  let { data, error } = await supabase
    .from(table)
    .select("*")
    .eq("slug", slug)
    .maybeSingle();

  if (error) throw error;

  // If not found, try stripping Decap's auto-appended "-N" suffix
  if (!data) {
    const baseSlug = slug.replace(/-\d+$/, "");
    if (baseSlug !== slug) {
      const result = await supabase
        .from(table)
        .select("*")
        .eq("slug", baseSlug)
        .maybeSingle();
      if (result.error) throw result.error;
      data = result.data;
    }
  }

  if (!data) throw new Error(`Entry not found: ${table}/${slug}`);

  return rowToFileData(data, table);
}

async function handleEntriesByFiles(params: {
  files: Array<{ path: string; label: string }>;
}) {
  // Fetch all requested entries, skip any that don't exist
  const results = [];
  for (const file of params.files) {
    try {
      const entry = await handleGetEntry({ path: file.path });
      results.push(entry);
    } catch {
      // Skip missing entries silently
    }
  }
  return results;
}

async function handlePersistEntry(params: {
  dataFiles: Array<{ path: string; slug: string; raw: string }>;
  assets: Array<{ path: string; content: string }>;
}) {
  const supabase = getSupabase();

  for (const dataFile of params.dataFiles) {
    const { table, slug } = parsePathInfo(dataFile.path);
    if (!ALLOWED_TABLES.includes(table)) {
      throw new Error(`Unknown collection: ${table}`);
    }

    const row = frontmatterToRow(dataFile.raw);
    if (!row.slug) row.slug = slug;

    const { error } = await supabase
      .from(table)
      .upsert(row as Record<string, unknown>, { onConflict: "slug" });

    if (error) throw error;
  }

  // Trigger rebuild in background, don't block response
  const hookUrl = process.env.NETLIFY_BUILD_HOOK_URL;
  if (hookUrl) {
    fetch(hookUrl, { method: "POST" }).catch(() => {});
  }

  return { message: "ok" };
}

async function handleDeleteFiles(params: { paths: string[] }) {
  const supabase = getSupabase();

  for (const path of params.paths) {
    const { table, slug } = parsePathInfo(path);
    if (!ALLOWED_TABLES.includes(table)) continue;

    const { error } = await supabase
      .from(table)
      .delete()
      .eq("slug", slug);

    if (error) throw error;
  }

  return { message: "ok" };
}

// ── Auth ──────────────────────────────────────────────────────────────

function checkAuth(request: Request): boolean {
  const adminPassword = process.env.DECAP_ADMIN_PASSWORD;
  if (!adminPassword) return true;
  const token = request.headers.get("X-Admin-Token") || "";
  return token === adminPassword;
}

// ── Main handler ──────────────────────────────────────────────────────

export default async function handler(request: Request) {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!checkAuth(request)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let action = "unknown";
  try {
    const body = await request.json();
    action = body.action;
    const params = body.params;

    if (action === "auth_check") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    let result: unknown;

    switch (action) {
      case "entriesByFolder":
        result = await handleEntriesByFolder(params);
        break;
      case "entriesByFiles":
        result = await handleEntriesByFiles(params);
        break;
      case "getEntry":
        result = await handleGetEntry(params);
        break;
      case "persistEntry":
        result = await handlePersistEntry(params);
        break;
      case "deleteFiles":
        result = await handleDeleteFiles(params);
        break;
      case "getMedia":
        result = [];
        break;
      case "getMediaFile":
        result = { id: "", content: "", encoding: "raw", path: "", name: "" };
        break;
      case "persistMedia":
        result = { asset: { id: "", name: "", size: 0, path: "", url: "" } };
        break;
      default:
        return new Response(
          JSON.stringify({ error: `Unknown action: ${action}` }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    let message = "Unknown error";
    if (err instanceof Error) {
      message = err.message;
    } else if (typeof err === "object" && err !== null) {
      message = JSON.stringify(err);
    } else if (typeof err === "string") {
      message = err;
    }
    console.error("Decap proxy error:", action, message);
    return new Response(JSON.stringify({ error: `API_ERROR: ${message}` }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
