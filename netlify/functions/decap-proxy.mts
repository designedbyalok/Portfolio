import { createClient } from "@supabase/supabase-js";
import matter from "gray-matter";

const ALLOWED_TABLES = ["blog_posts", "works"];

function getSupabase() {
  // Log ALL env var names that contain "SUPA" for debugging
  const allKeys = Object.keys(process.env).filter(
    (k) => k.includes("SUPA") || k.includes("supa")
  );
  console.log("ENV KEYS matching SUPA*:", allKeys);
  console.log(
    "SUPABASE_URL present:",
    !!process.env.SUPABASE_URL,
    "length:",
    (process.env.SUPABASE_URL || "").length
  );
  console.log(
    "PUBLIC_SUPABASE_URL present:",
    !!process.env.PUBLIC_SUPABASE_URL,
    "length:",
    (process.env.PUBLIC_SUPABASE_URL || "").length
  );
  console.log(
    "SUPABASE_SERVICE_ROLE_KEY present:",
    !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    "length:",
    (process.env.SUPABASE_SERVICE_ROLE_KEY || "").length
  );

  const url =
    process.env.SUPABASE_URL ||
    process.env.PUBLIC_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL;

  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    const missing = [];
    if (!url) missing.push("SUPABASE_URL");
    if (!key) missing.push("SUPABASE_SERVICE_ROLE_KEY");
    // Include ALL env var names (not values) in the error for debugging
    const envNames = Object.keys(process.env).sort().join(", ");
    throw new Error(
      `Missing env vars: ${missing.join(", ")}. Available env names: [${envNames}]`
    );
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

async function handlePersistMedia(params: Record<string, unknown>) {
  console.log("persistMedia params keys:", Object.keys(params || {}));

  // Decap proxy sends: { asset: { path, content, encoding } }
  const asset = (params?.asset || params) as {
    path?: string;
    content?: string;
    encoding?: string;
  };

  if (!asset?.path || !asset?.content) {
    console.log("persistMedia full params:", JSON.stringify(params).slice(0, 500));
    // Return a stub so Decap doesn't crash — media just won't be stored
    const name = asset?.path || "unknown";
    return {
      asset: { id: name, name, size: 0, path: name, url: "" },
    };
  }

  const supabase = getSupabase();

  // Decode the base64 content
  const encoding = (asset.encoding || "base64") as BufferEncoding;
  const buffer = Buffer.from(asset.content, encoding);
  const fileName = asset.path.replace(/^\/?(public\/)?uploads\//, "");
  const storagePath = `uploads/${fileName}`;

  // Upload to Supabase Storage (bucket: "media")
  const { error } = await supabase.storage
    .from("media")
    .upload(storagePath, buffer, { upsert: true });

  if (error) {
    console.error("Storage upload error:", error);
    throw error;
  }

  // Get the public URL
  const { data: urlData } = supabase.storage
    .from("media")
    .getPublicUrl(storagePath);

  // Decap CMS expects { asset: { ... } }
  return {
    asset: {
      id: storagePath,
      name: fileName,
      size: buffer.length,
      path: `/uploads/${fileName}`,
      url: urlData.publicUrl,
    },
  };
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
        result = await handlePersistMedia(params);
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
