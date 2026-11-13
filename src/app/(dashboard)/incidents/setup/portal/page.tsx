import { redirect } from "next/navigation";

// The coach portal is managed by the Halo administrator, not by a school. This address used to hold it, and "Keeping records"; that part moved.
export default function IncidentPortalMovedPage() {
  redirect("/incidents/setup/records");
}
