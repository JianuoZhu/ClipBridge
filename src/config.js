import path from "node:path";

function integer(value, fallback, minimum, maximum, name) {
  const normalized = value === undefined || value === "" ? String(fallback) : String(value).trim();
  const parsed = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function loadConfig(env = process.env) {
  const pin = env.CLIP_PIN ?? "1223";
  if (typeof pin !== "string" || !/^\d{4,12}$/.test(pin)) {
    throw new Error("CLIP_PIN must contain 4 to 12 digits");
  }
  const password = env.CLIP_PASSWORD ?? "";
  if (typeof password !== "string" || (password !== "" && (password.length < 12 || password.length > 1024 ||
      !password.trim() || password === "replace-with-a-long-random-password"))) {
    throw new Error("CLIP_PASSWORD must contain 12 to 1024 characters and must not be blank or the example password");
  }

  const domain = (env.CLIP_DOMAIN ?? "").trim().toLowerCase();
  const hostname = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
  if (domain && (domain.length > 253 || !hostname.test(domain))) {
    throw new Error("CLIP_DOMAIN must be a hostname without a scheme or path");
  }

  const username = (env.CLIP_USERNAME || "admin").trim();
  if (!username || username.length > 128 || /[\u0000-\u001f\u007f]/.test(username)) {
    throw new Error("CLIP_USERNAME must contain 1 to 128 characters without control characters");
  }
  const secure = (env.CLIP_COOKIE_SECURE ?? "true").trim().toLowerCase();
  if (secure !== "true" && secure !== "false") {
    throw new Error("CLIP_COOKIE_SECURE must be true or false");
  }

  return {
    port: integer(env.CLIP_PORT, 8080, 1, 65535, "CLIP_PORT"),
    dataDir: path.resolve(env.CLIP_DATA_DIR || "./data"),
    domain,
    pin,
    username,
    password,
    retentionHours: integer(env.CLIP_RETENTION_HOURS, 24, 1, 8760, "CLIP_RETENTION_HOURS"),
    maxFileBytes: integer(env.CLIP_MAX_FILE_MB, 512, 1, 10240, "CLIP_MAX_FILE_MB") * 1024 * 1024,
    maxStorageBytes: integer(env.CLIP_MAX_STORAGE_GB, 5, 1, 1024, "CLIP_MAX_STORAGE_GB") * 1024 * 1024 * 1024,
    maxTextBytes: integer(env.CLIP_MAX_TEXT_KB, 1024, 1, 4096, "CLIP_MAX_TEXT_KB") * 1024,
    sessionDays: integer(env.CLIP_SESSION_DAYS, 30, 1, 365, "CLIP_SESSION_DAYS"),
    cookieSecure: secure === "true",
  };
}
