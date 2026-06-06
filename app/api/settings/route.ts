import { NextRequest, NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/settings";

export async function GET() {
  const settings = await getSettings();
  return NextResponse.json(settings);
}

export async function PATCH(req: NextRequest) {
  const patch = await req.json();
  const updated = await updateSettings(patch);
  return NextResponse.json(updated);
}
