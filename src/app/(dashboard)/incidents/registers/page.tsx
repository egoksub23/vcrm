import { redirect } from "next/navigation";

// This page moved; the old address keeps working for links in emails and bookmarks.
export default function IncidentsMovedPage() {
  redirect("/incidents/reports?tab=registers");
}
