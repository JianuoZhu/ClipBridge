import path from "node:path";

function integer(value, fallback, minimum, maximum, name) {
  const parsed = value === undefined || value === "" ? fallback : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function loadConfig(env = process.env) {
  const password = env.CLIP_PASSWORD ?? "";
  if (password.length < 12 || password === "replace-with-a-long-random-password") {
    throw new Error("CLIP_PASSWORD must contain at least 12 characters");
  }

  const domain = (env.CLIP_DOMAIN ?? "").trim().toLowerCase();
  if (domain && !/^[a-z0-9.-]+$/.test(domain)) {
    throw new Error("CLIP_DOMAIN must be a hostname without a scheme or path");
  }

  return {
    port: integer(env.CLIP_PORT, 8080, 1, 65535, "CLIP_PORT"),
    dataDir: path.resolve(env.CLIP_DATA_DIR || "./data"),
    domain,
    username: (env.CLIP_USERNAME || "admin").trim(),
    password,
    retentionHours: integer(env.CLIP_RETENTION_HOURS, 24, 1, 8760, "CLIP_RETENTION_HOURS"),
    maxFileBytes: integer(env.CLIP_MAX_FILE_MB, 512, 1, 10240, "CLIP_MAX_FILE_MB") * 1024 * 1024,
    maxStorageBytes: integer(env.CLIP_MAX_STORAGE_GB, 5, 1, 1024, "CLIP_MAX_STORAGE_GB") * 1024 * 1024 * 1024,
    maxTextBytes: integer(env.CLIP_MAX_TEXT_KB, 1024, 1, 4096, "CLIP_MAX_TEXT_KB") * 1024,
    sessionDays: integer(env.CLIP_SESSION_DAYS, 30, 1, 365, "CLIP_SESSION_DAYS"),
    cookieSecure: (env.CLIP_COOKIE_SECURE ?? "true").toLowerCase() !== "false",
  };
}
