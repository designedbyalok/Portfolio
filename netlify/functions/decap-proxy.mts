import { createClient } from "@supabase/supabase-js";
import matter from "gray-matter";

const ALLOWED_TABLES = ["blog_posts", "works"];

function getEnv(name: string): string | undefined {
  // Netlify Functions v2: try Netlify.env first, fall back to process.env
  try {
    // @ts-ignore — Netlify global available at runtime
    return globalThis.Netlify?.env?.get(name) || process.env[name];
  } catch {
    return process.env[name];
  }
}

function getSupabase() {
  const url = getEnv("SUPABASE_URL") || getEnv("PUBLIC_SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    const missing = [];
    if (!url) missing.push("SUPABASE_URL");
    if (!key) missing.push("SUPABASE_SERVICE_ROLE_KEY");
    throw new Error(`Missing env vars: ${missing.join(", ")}. Check Netlify Dashboard > Site settings > Environment variables. Ensure scope includes "Functions".`);
  }
  return createClient(url, key);
}

function parsePathInfo(path: string): { table: string; slug: string } {
  // Path format: "blog_posts/my-slug.md"
  const parts = path.split("/");
  const table = parts[0];
  const slug = parts[parts.length - 1].replace(/\.md$/, "");
  return { table, slug };
}

function rowToFrontmatter(row: Record<string, unknown>, table: string): string {
  const { id, content, created_at, ...fields } = row as Record<string, unknown>;
  // Serialize fields as YAML frontmatter + markdown body
  const frontmatterData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    frontmatterData[key] = value;
  }
  return matter.stringify(String(content || ""), frontmatterData);
}

function frontmatterToRow(raw: string): Record<string, unknown> {
  const { data, content } = matter(raw);
  const row: Record<string, unknown> = { ...data, content: content.trim() };
  // Map "body" field to "content" if present (Decap convention)
  if ("body" in row) {
    row.content = row.body;
    delete row.body;
  }
  return row;
}

async function triggerRebuild() {
  const hookUrl = process.env.NETLIFY_BUILD_HOOK_URL;
  if (hookUrl) {
    try {
      await fetch(hookUrl, { method: "POST" });
    } catch {
      // Fire and forget — don't fail the request if rebuild trigger fails
    }
  }
}

async function handleEntriesByFolder(params: {
  folder: string;
  extension: string;
}) {
  const { folder } = params;
  if (!ALLOWED_TABLES.includes(folder)) {
    return [];
  }
  const supabase = getSupabase();
  const { data, error } = await supabase.from(folder).select("*");
  if (error) throw error;

  return (data || []).map((row) => ({
    file: { path: `${folder}/${row.slug}.md`, label: row.title },
    data: rowToFrontmatter(row, folder),
  }));
}

async function handleGetEntry(params: { path: string }) {
  const { table, slug } = parsePathInfo(params.path);
  if (!ALLOWED_TABLES.includes(table)) {
    throw new Error(`Unknown collection: ${table}`);
  }
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from(table)
    .select("*")
    .eq("slug", slug)
    .single();
  if (error) throw error;

  return {
    file: { path: `${table}/${slug}.md`, label: data.title },
    data: rowToFrontmatter(data, table),
  };
}

async function handleEntriesByFiles(params: {
  files: Array<{ path: string; label: string }>;
}) {
  const results = await Promise.all(
    params.files.map((file) => handleGetEntry({ path: file.path }))
  );
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
    // Ensure slug is set from the path if not in frontmatter
    if (!row.slug) {
      row.slug = slug;
    }

    const { error } = await supabase
      .from(table)
      .upsert(row as Record<string, unknown>, { onConflict: "slug" });

    if (error) throw error;
  }

  await triggerRebuild();
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

  await triggerRebuild();
}

export default async function handler(request: Request) {
  // Only accept POST
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await request.json();
    const { action, params } = body;

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
        result = { url: "" };
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
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("Decap proxy error:", err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
