export function validatePublicBase(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const url = new URL(trimmed);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || /[\\\r\n]/.test(trimmed)) {
    throw new Error("Use an HTTPS address without credentials, query parameters or fragments.");
  }
  return url.href.replace(/\/+$/, "");
}

export function phoneLink(base: string, entryPath: string): string {
  const valid = validatePublicBase(base);
  if (!valid) throw new Error("Set your public Hermes address before copying a phone link.");
  if (!entryPath.startsWith("/apps/") || entryPath.includes("..") || /[\\\r\n?#]/.test(entryPath)) {
    throw new Error("Expected a signed-in app entry path.");
  }
  return `${valid}${entryPath}`;
}
