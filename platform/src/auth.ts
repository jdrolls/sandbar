import { timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "sandbar_token";

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function isAuthorized(request: Request, token: string): boolean {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ") && constantTimeEqual(authorization.slice(7), token)) {
    return true;
  }
  const cookie = cookieValue(request, COOKIE_NAME);
  return cookie !== null && constantTimeEqual(cookie, token);
}

export function loginCookie(token: string): string {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`;
}

export function logoutCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}
