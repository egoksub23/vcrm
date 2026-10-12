// ============================================================
// GET /api/kyc/status   (menu.kyc)   [?check=1]
//
// Is KYC review set up, is it the UAT back end, and what may the caller do. An administrator also sees WHICH environment variables are missing (their
// names, never a value); everyone else gets an empty list. `check=1` (administrators only, a few a minute) also asks the back end's /health, which sends
// no key, so "the service is down" can be told from "the key is rejected". The base URL and the key are never returned.
// ============================================================
import { json, kycStaff } from "@/lib/kyc/http";
import { kycStatus } from "@/lib/kyc/service";

export async function GET(request: Request) {
  const check = new URL(request.url).searchParams.get("check") === "1";
  return kycStaff({ bucket: check ? "status-check" : "status", perMinute: check ? 6 : 60 }, async ({ caller, runtime }) => {
    return json(await kycStatus(caller, runtime, { check }));
  });
}
