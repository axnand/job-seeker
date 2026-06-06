import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const BASIC_USER = "admin";
const PASS = process.env.APP_PASSWORD ?? "changeme";
const CRON_SECRET = process.env.CRON_SECRET ?? "";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Cron routes: Vercel sends Authorization: Bearer <CRON_SECRET>
  if (pathname.startsWith("/api/cron/")) {
    const auth = req.headers.get("authorization") ?? "";
    if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
    return NextResponse.next();
  }

  // Unipile webhooks: verified by HMAC inside the route handler
  if (pathname.startsWith("/api/webhooks/unipile")) {
    return NextResponse.next();
  }

  // Everything else (dashboard + API): basic auth
  const authHeader = req.headers.get("authorization");
  if (authHeader) {
    const [scheme, encoded] = authHeader.split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString("utf-8");
      const [user, password] = decoded.split(":");
      if (user === BASIC_USER && password === PASS) {
        return NextResponse.next();
      }
    }
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Job Seeker", charset="UTF-8"',
    },
  });
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
